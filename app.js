// ============================================================
//  نظام مبتكر - المنطق الرئيسي
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, doc, runTransaction,
  updateDoc, deleteDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let invoicesCache = [];
let expensesCache = [];
let rowCount = 0;
let editingInvoiceId = null;
let editingExpenseId = null;
let currentPayStatus = 'unpaid';

// ---------------------------------------------------------------
// التنقل بين التبويبات
// ---------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=> showView(btn.dataset.view));
});
function showView(name){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active', b.dataset.view===name));
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
}

// ---------------------------------------------------------------
// مؤشر الاتصال
// ---------------------------------------------------------------
function updateSyncIndicator(){
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if(navigator.onLine){ dot.classList.remove('offline'); text.textContent = 'متصل ومتزامن'; }
  else{ dot.classList.add('offline'); text.textContent = 'غير متصل - سيتم الحفظ لاحقًا'; }
}
window.addEventListener('online', updateSyncIndicator);
window.addEventListener('offline', updateSyncIndicator);
updateSyncIndicator();

// ---------------------------------------------------------------
// أدوات مساعدة للتاريخ
// ---------------------------------------------------------------
function todayStr(){ return new Date().toISOString().slice(0,10); }
function daysAgoStr(n){ const d = new Date(); d.setDate(d.getDate()-n); return d.toISOString().slice(0,10); }
function monthStartStr(){ const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`; }
function fmtDateDisplay(s){ if(!s) return '—'; const [y,m,d]=s.split('-'); return `${d}/${m}/${y}`; }

// ---------------------------------------------------------------
// الفاتورة - الأصناف والحساب
// ---------------------------------------------------------------
function rowTemplate(name='', price='', qty=1){
  rowCount++;
  const id = 'row_'+rowCount+'_'+Date.now();
  return `<tr id="${id}">
    <td class="desc"><input type="text" placeholder="اسم الصنف" value="${name}" oninput="App.calc()"></td>
    <td><input type="number" placeholder="0" min="0" step="0.001" value="${price}" oninput="App.calc()"></td>
    <td><input type="number" placeholder="1" min="0" step="1" value="${qty}" oninput="App.calc()"></td>
    <td class="total-cell">0.000</td>
    <td><button class="del-row" onclick="App.delRow('${id}')">✕</button></td>
  </tr>`;
}
function addRow(name,price,qty){ document.getElementById('itemsBody').insertAdjacentHTML('beforeend', rowTemplate(name,price,qty)); calc(); }
function delRow(id){ const el = document.getElementById(id); if(el) el.remove(); calc(); }

function setPayStatus(status){
  currentPayStatus = status;
  document.querySelectorAll('.pay-btn').forEach(b=> b.classList.toggle('active', b.dataset.status===status));
  document.getElementById('partialWrap').style.display = status==='partial' ? 'block' : 'none';
  calc();
}

function calc(){
  let subtotal = 0;
  document.querySelectorAll('#itemsBody tr').forEach(tr=>{
    const price = parseFloat(tr.children[1].querySelector('input').value) || 0;
    const qty = parseFloat(tr.children[2].querySelector('input').value) || 0;
    const total = price * qty;
    tr.children[3].textContent = total.toFixed(3);
    subtotal += total;
  });
  const discount = parseFloat(document.getElementById('discount').value) || 0;
  const shipping = parseFloat(document.getElementById('shipping').value) || 0;
  const grand = subtotal - discount + shipping;
  document.getElementById('subtotalVal').textContent = subtotal.toFixed(3) + ' ر.ع';
  document.getElementById('grandTotal').textContent = grand.toFixed(3) + ' ر.ع';

  let amountPaid = 0;
  if(currentPayStatus === 'paid') amountPaid = grand;
  else if(currentPayStatus === 'partial') amountPaid = parseFloat(document.getElementById('amountPaid').value) || 0;

  const remaining = Math.max(0, grand - amountPaid);
  const remWrap = document.getElementById('remainingWrap');
  if(currentPayStatus !== 'paid' && grand > 0){
    remWrap.style.display = 'block';
    remWrap.textContent = 'المتبقي على العميل: ' + remaining.toFixed(3) + ' ر.ع';
  }else{
    remWrap.style.display = 'none';
  }

  return { subtotal, discount, shipping, grand, amountPaid, remaining };
}

function collectItems(){
  const items = [];
  document.querySelectorAll('#itemsBody tr').forEach(tr=>{
    const name = tr.children[0].querySelector('input').value.trim();
    const price = parseFloat(tr.children[1].querySelector('input').value) || 0;
    const qty = parseFloat(tr.children[2].querySelector('input').value) || 0;
    if(name || price || qty) items.push({ name, price, qty, total: price*qty });
  });
  return items;
}

function syncMiniMeta(){
  document.getElementById('invDateDisplay').textContent = fmtDateDisplay(document.getElementById('invDate').value);
}

function newInvoice(){
  editingInvoiceId = null;
  document.getElementById('editBanner').style.display = 'none';
  document.getElementById('saveInvoiceBtn').textContent = '💾 حفظ الفاتورة';
  document.getElementById('custName').value = '';
  document.getElementById('custRegion').value = '';
  document.getElementById('custState').value = '';
  document.getElementById('discount').value = '';
  document.getElementById('shipping').value = '';
  document.getElementById('notes').value = '';
  document.getElementById('amountPaid').value = '';
  document.getElementById('itemsBody').innerHTML = '';
  document.getElementById('invNoDisplay').textContent = 'سيُحدَّد عند الحفظ';
  document.getElementById('invDate').value = todayStr();
  syncMiniMeta();
  setPayStatus('unpaid');
  addRow();
  calc();
  showView('invoice');
}

// ---------------------------------------------------------------
// عدّاد رقم الفاتورة المشترك
// ---------------------------------------------------------------
async function getNextInvoiceNumber(){
  const counterRef = doc(db, 'settings', 'counter');
  return await runTransaction(db, async (tx)=>{
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? (snap.data().value || 0) : 0;
    const n = current + 1;
    tx.set(counterRef, { value: n }, { merge:true });
    return n;
  });
}

async function saveInvoice(){
  const items = collectItems();
  if(items.length === 0){ alert('أضف صنف واحد على الأقل قبل الحفظ'); return; }
  const totals = calc();
  const btn = document.getElementById('saveInvoiceBtn');
  const originalText = btn.textContent;
  btn.disabled = true; btn.textContent = 'جارِ الحفظ...';
  try{
    const baseData = {
      customerName: document.getElementById('custName').value.trim(),
      region: document.getElementById('custRegion').value.trim(),
      state: document.getElementById('custState').value.trim(),
      date: document.getElementById('invDate').value || todayStr(),
      items,
      subtotal: totals.subtotal,
      discount: totals.discount,
      shipping: totals.shipping,
      total: totals.grand,
      notes: document.getElementById('notes').value.trim(),
      paymentStatus: currentPayStatus,
      amountPaid: totals.amountPaid,
      remaining: totals.remaining
    };

    if(editingInvoiceId){
      await updateDoc(doc(db,'invoices',editingInvoiceId), baseData);
      alert('تم تحديث الفاتورة بنجاح');
      newInvoice();
    }else{
      const number = await getNextInvoiceNumber();
      const invNoStr = 'INV-' + String(number).padStart(4,'0');
      baseData.number = number;
      baseData.invNoStr = invNoStr;
      baseData.createdAt = serverTimestamp();
      await addDoc(collection(db,'invoices'), baseData);
      document.getElementById('invNoDisplay').textContent = invNoStr;
      alert('تم حفظ الفاتورة برقم ' + invNoStr);
    }
  }catch(err){
    console.error(err);
    alert('صار خطأ أثناء الحفظ، تأكد من اتصال الإنترنت وإعدادات Firebase');
  }finally{
    btn.disabled = false; btn.textContent = originalText;
  }
}

function editInvoice(id){
  const inv = invoicesCache.find(x=>x.id===id);
  if(!inv) return;
  editingInvoiceId = id;
  document.getElementById('editBanner').style.display = 'flex';
  document.getElementById('editBannerText').textContent = 'وضع التعديل — الفاتورة ' + (inv.invNoStr||'');
  document.getElementById('saveInvoiceBtn').textContent = '💾 تحديث الفاتورة';

  document.getElementById('custName').value = inv.customerName || '';
  document.getElementById('custRegion').value = inv.region || '';
  document.getElementById('custState').value = inv.state || '';
  document.getElementById('invDate').value = inv.date || todayStr();
  document.getElementById('discount').value = inv.discount || '';
  document.getElementById('shipping').value = inv.shipping || '';
  document.getElementById('notes').value = inv.notes || '';
  document.getElementById('invNoDisplay').textContent = inv.invNoStr || '';
  syncMiniMeta();

  document.getElementById('itemsBody').innerHTML = '';
  (inv.items && inv.items.length ? inv.items : [{}]).forEach(it=> addRow(it.name||'', it.price||'', it.qty!=null?it.qty:1));

  setPayStatus(inv.paymentStatus || 'unpaid');
  document.getElementById('amountPaid').value = inv.amountPaid || '';
  calc();
  showView('invoice');
  window.scrollTo({top:0, behavior:'smooth'});
}

async function deleteInvoice(id){
  if(!confirm('متأكد تبي تحذف هذي الفاتورة؟ لا يمكن التراجع')) return;
  try{ await deleteDoc(doc(db,'invoices',id)); }
  catch(err){ console.error(err); alert('تعذّر الحذف، تأكد من الاتصال'); }
}

// ---------------------------------------------------------------
// الشعار
// ---------------------------------------------------------------
function resizeImage(file, maxW){
  return new Promise((resolve)=>{
    const reader = new FileReader();
    reader.onload = (e)=>{
      const img = new Image();
      img.onload = ()=>{
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width = img.width * scale;
        canvas.height = img.height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png', 0.85));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}
function applyLogo(dataUrl){
  document.getElementById('logoImg').src = dataUrl;
  document.getElementById('logoImg').style.display = 'block';
  document.getElementById('logoHint').style.display = 'none';
}
document.getElementById('logoInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const dataUrl = await resizeImage(file, 300);
  applyLogo(dataUrl);
  try{ await setDoc(doc(db,'settings','branding'), { logoDataUrl: dataUrl }, { merge:true }); }
  catch(err){ console.error(err); alert('تعذّر حفظ الشعار على كل الأجهزة، تأكد من الاتصال'); }
});
onSnapshot(doc(db,'settings','branding'), (snap)=>{
  if(snap.exists() && snap.data().logoDataUrl){ applyLogo(snap.data().logoDataUrl); }
});

// ---------------------------------------------------------------
// قوائم الفواتير والمصاريف
// ---------------------------------------------------------------
function payBadge(inv){
  const status = inv.paymentStatus || 'unpaid';
  if(status === 'paid') return `<span class="badge badge-paid">مدفوعة</span>`;
  if(status === 'partial') return `<span class="badge badge-partial">جزئي</span>`;
  return `<span class="badge badge-unpaid">غير مدفوعة</span>`;
}

function renderInvoicesList(){
  const wrap = document.getElementById('invoicesList');
  if(invoicesCache.length === 0){ wrap.innerHTML = '<div class="empty">لا توجد فواتير بعد</div>'; return; }
  wrap.innerHTML = invoicesCache.map(inv=>{
    const remaining = inv.remaining || 0;
    const status = inv.paymentStatus || 'unpaid';
    return `
    <div class="list-item">
      <div>
        <div class="main">${inv.invNoStr || ''} — ${inv.customerName || 'بدون اسم'} ${payBadge(inv)}</div>
        <div class="sub">${fmtDateDisplay(inv.date)} · ${inv.region || ''} ${inv.state ? '- '+inv.state : ''}</div>
      </div>
      <div class="right-block">
        <div class="amt">${(inv.total||0).toFixed(3)} ر.ع
          ${status!=='paid' && remaining>0 ? `<small>متبقي ${remaining.toFixed(3)}</small>` : ''}
        </div>
        <div class="actions">
          <button class="icon-btn" title="تعديل" onclick="App.editInvoice('${inv.id}')">✎</button>
          <button class="icon-btn danger" title="حذف" onclick="App.deleteInvoice('${inv.id}')">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function renderExpensesList(){
  const wrap = document.getElementById('expensesList');
  if(expensesCache.length === 0){ wrap.innerHTML = '<div class="empty">لا توجد مصاريف بعد</div>'; return; }
  wrap.innerHTML = expensesCache.map(ex=>`
    <div class="list-item">
      <div>
        <div class="main">${ex.description || 'بدون وصف'}</div>
        <div class="sub">${fmtDateDisplay(ex.date)} · ${ex.category || ''}</div>
      </div>
      <div class="right-block">
        <div class="amt exp">- ${(ex.amount||0).toFixed(3)} ر.ع</div>
        <div class="actions">
          <button class="icon-btn" title="تعديل" onclick="App.editExpense('${ex.id}')">✎</button>
          <button class="icon-btn danger" title="حذف" onclick="App.deleteExpense('${ex.id}')">🗑</button>
        </div>
      </div>
    </div>
  `).join('');
}

onSnapshot(query(collection(db,'invoices'), orderBy('createdAt','desc')), (snap)=>{
  invoicesCache = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  renderInvoicesList();
  renderDashboard();
});
onSnapshot(query(collection(db,'expenses'), orderBy('createdAt','desc')), (snap)=>{
  expensesCache = snap.docs.map(d=>({ id:d.id, ...d.data() }));
  renderExpensesList();
  renderDashboard();
});

// ---------------------------------------------------------------
// المصاريف - حفظ / تعديل / حذف
// ---------------------------------------------------------------
async function saveExpense(){
  const desc = document.getElementById('expDesc').value.trim();
  const amount = parseFloat(document.getElementById('expAmount').value) || 0;
  const category = document.getElementById('expCategory').value;
  const date = document.getElementById('expDate').value || todayStr();
  if(!desc || amount <= 0){ alert('أدخل وصف ومبلغ صحيح'); return; }
  try{
    if(editingExpenseId){
      await updateDoc(doc(db,'expenses',editingExpenseId), { description:desc, amount, category, date });
    }else{
      await addDoc(collection(db,'expenses'), { description: desc, amount, category, date, createdAt: serverTimestamp() });
    }
    cancelExpenseEdit();
  }catch(err){ console.error(err); alert('تعذّر حفظ المصروف، تأكد من الاتصال'); }
}

function editExpense(id){
  const ex = expensesCache.find(x=>x.id===id);
  if(!ex) return;
  editingExpenseId = id;
  document.getElementById('expenseFormTitle').textContent = '✎ تعديل مصروف';
  document.getElementById('expDesc').value = ex.description || '';
  document.getElementById('expAmount').value = ex.amount || '';
  document.getElementById('expCategory').value = ex.category || 'أخرى';
  document.getElementById('expDate').value = ex.date || todayStr();
  document.getElementById('saveExpenseBtn').textContent = '💾 تحديث المصروف';
  document.getElementById('cancelExpenseBtn').style.display = 'inline-block';
  showView('expenses');
  window.scrollTo({top:0, behavior:'smooth'});
}

function cancelExpenseEdit(){
  editingExpenseId = null;
  document.getElementById('expenseFormTitle').textContent = '➖ إضافة مصروف';
  document.getElementById('expDesc').value = '';
  document.getElementById('expAmount').value = '';
  document.getElementById('expCategory').value = 'خامات';
  document.getElementById('expDate').value = todayStr();
  document.getElementById('saveExpenseBtn').textContent = '💾 حفظ المصروف';
  document.getElementById('cancelExpenseBtn').style.display = 'none';
}

async function deleteExpense(id){
  if(!confirm('متأكد تبي تحذف هذا المصروف؟')) return;
  try{ await deleteDoc(doc(db,'expenses',id)); }
  catch(err){ console.error(err); alert('تعذّر الحذف، تأكد من الاتصال'); }
}
document.getElementById('expDate').value = todayStr();

// ---------------------------------------------------------------
// لوحة التحكم: نظرة سريعة + تقارير
// ---------------------------------------------------------------
function sumIn(list, field, from, to){
  return list.filter(x => x.date >= from && x.date <= to).reduce((s,x)=> s + (x[field]||0), 0);
}
function countIn(list, from, to){
  return list.filter(x => x.date >= from && x.date <= to).length;
}
function statCardHTML(title, income, expense, invCount){
  const profit = income - expense;
  return `<div class="stat-card">
    <h3>${title}</h3>
    <div class="row"><label>عدد الفواتير</label><span class="v">${invCount}</span></div>
    <div class="row"><label>الدخل</label><span class="v income">${income.toFixed(3)} ر.ع</span></div>
    <div class="row"><label>المصاريف</label><span class="v expense">${expense.toFixed(3)} ر.ع</span></div>
    <div class="row"><label>الربح الصافي</label><span class="v profit">${profit.toFixed(3)} ر.ع</span></div>
  </div>`;
}

function renderQuickGrid(){
  const wrap = document.getElementById('quickGrid');
  const last = invoicesCache[0];
  const lastHtml = `<div class="card highlight-card">
    <h3 style="color:var(--muted);font-size:13px;font-weight:800;margin:0 0 8px;">🧾 آخر فاتورة</h3>
    ${last ? `
      <div class="hc-invoice-no">${last.invNoStr||''}</div>
      <div class="hc-cust">${last.customerName || 'بدون اسم'}</div>
      <div class="hc-sub">${fmtDateDisplay(last.date)} · ${payBadge(last)}</div>
      <div class="hc-amt">${(last.total||0).toFixed(3)} ر.ع</div>
      <span class="hc-open" onclick="App.showView('invoices-list')">عرض كل الفواتير ←</span>
    ` : `<div class="hc-empty">ما فيه فواتير بعد</div>`}
  </div>`;

  const unpaid = invoicesCache.filter(inv => (inv.paymentStatus||'unpaid') !== 'paid');
  const duesTotal = unpaid.reduce((s,inv)=> s + (inv.remaining!=null ? inv.remaining : (inv.total||0)), 0);
  const duesHtml = `<div class="card highlight-card">
    <h3 style="color:var(--muted);font-size:13px;font-weight:800;margin:0 0 8px;">💸 مستحقات على العملاء</h3>
    ${unpaid.length ? `
      <div class="dues-total">${duesTotal.toFixed(3)} ر.ع</div>
      <div class="dues-count">${unpaid.length} فاتورة غير مسدّدة بالكامل</div>
      <span class="hc-open" onclick="App.showView('invoices-list')">عرض التفاصيل ←</span>
    ` : `<div class="hc-empty">كل الفواتير مسدّدة 👍</div>`}
  </div>`;

  wrap.innerHTML = lastHtml + duesHtml;
}

function renderDashboard(){
  renderQuickGrid();
  const t = todayStr();
  const w = daysAgoStr(6);
  const m = monthStartStr();
  document.getElementById('statsGrid').innerHTML =
    statCardHTML('اليوم', sumIn(invoicesCache,'total',t,t), sumIn(expensesCache,'amount',t,t), countIn(invoicesCache,t,t)) +
    statCardHTML('آخر 7 أيام', sumIn(invoicesCache,'total',w,t), sumIn(expensesCache,'amount',w,t), countIn(invoicesCache,w,t)) +
    statCardHTML('هذا الشهر', sumIn(invoicesCache,'total',m,t), sumIn(expensesCache,'amount',m,t), countIn(invoicesCache,m,t));
}

// ---------------------------------------------------------------
// التهيئة
// ---------------------------------------------------------------
newInvoice();
renderDashboard();

window.App = {
  addRow, delRow, calc, newInvoice, saveInvoice, editInvoice, deleteInvoice,
  saveExpense, editExpense, deleteExpense, cancelExpenseEdit,
  setPayStatus, syncMiniMeta, showView
};
