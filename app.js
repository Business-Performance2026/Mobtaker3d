// ============================================================
//  نظام مبتكر - المنطق الرئيسي
//  يعتمد على Firebase Firestore لمزامنة البيانات بين كل الأجهزة
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, doc, runTransaction,
  getDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

let invoicesCache = [];
let expensesCache = [];
let rowCount = 0;

// ---------------------------------------------------------------
// التنقل بين التبويبات
// ---------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-'+btn.dataset.view).classList.add('active');
  });
});

// ---------------------------------------------------------------
// مؤشر الاتصال
// ---------------------------------------------------------------
function updateSyncIndicator(){
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if(navigator.onLine){
    dot.classList.remove('offline'); text.textContent = 'متصل ومتزامن';
  }else{
    dot.classList.add('offline'); text.textContent = 'غير متصل - سيتم الحفظ لاحقًا';
  }
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

// ---------------------------------------------------------------
// الفاتورة - الأصناف والحساب
// ---------------------------------------------------------------
function rowTemplate(){
  rowCount++;
  const id = 'row_'+rowCount+'_'+Date.now();
  return `<tr id="${id}">
    <td class="desc"><input type="text" placeholder="اسم الصنف" oninput="App.calc()"></td>
    <td><input type="number" placeholder="0" min="0" step="0.001" oninput="App.calc()"></td>
    <td><input type="number" placeholder="1" min="0" step="1" value="1" oninput="App.calc()"></td>
    <td class="total-cell">0.000</td>
    <td><button class="del-row" onclick="App.delRow('${id}')">✕</button></td>
  </tr>`;
}

function addRow(){
  document.getElementById('itemsBody').insertAdjacentHTML('beforeend', rowTemplate());
}
function delRow(id){
  const el = document.getElementById(id);
  if(el) el.remove();
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
  return { subtotal, discount, shipping, grand };
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

function newInvoice(){
  document.getElementById('custName').value = '';
  document.getElementById('custRegion').value = '';
  document.getElementById('custState').value = '';
  document.getElementById('discount').value = '';
  document.getElementById('shipping').value = '';
  document.getElementById('notes').value = '';
  document.getElementById('itemsBody').innerHTML = '';
  document.getElementById('invNo').value = 'سيُحدَّد عند الحفظ';
  document.getElementById('invDate').value = todayStr();
  addRow();
  calc();
}

// ---------------------------------------------------------------
// عدّاد رقم الفاتورة المشترك (متزامن عبر Firestore transaction)
// كل فاتورة تاخذ رقم أعلى من اللي قبلها مباشرة، بدون تكرار أو تخطي
// ---------------------------------------------------------------
async function getNextInvoiceNumber(){
  const counterRef = doc(db, 'settings', 'counter');
  const next = await runTransaction(db, async (tx)=>{
    const snap = await tx.get(counterRef);
    const current = snap.exists() ? (snap.data().value || 0) : 0;
    const n = current + 1;
    tx.set(counterRef, { value: n }, { merge:true });
    return n;
  });
  return next;
}

async function saveInvoice(){
  const items = collectItems();
  if(items.length === 0){
    alert('أضف صنف واحد على الأقل قبل الحفظ');
    return;
  }
  const totals = calc();
  const btn = event.target;
  btn.disabled = true; btn.textContent = 'جارِ الحفظ...';
  try{
    const number = await getNextInvoiceNumber();
    const invNoStr = 'INV-' + String(number).padStart(4,'0');
    const data = {
      number, invNoStr,
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
      createdAt: serverTimestamp()
    };
    await addDoc(collection(db,'invoices'), data);
    document.getElementById('invNo').value = invNoStr;
    alert('تم حفظ الفاتورة برقم ' + invNoStr);
  }catch(err){
    console.error(err);
    alert('صار خطأ أثناء الحفظ، تأكد من اتصال الإنترنت وإعدادات Firebase');
  }finally{
    btn.disabled = false; btn.textContent = '💾 حفظ الفاتورة';
  }
}

// ---------------------------------------------------------------
// الشعار (يُخزَّن مرة وحدة ويظهر في كل الفواتير على كل الأجهزة)
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
  document.getElementById('watermark').style.backgroundImage = `url(${dataUrl})`;
}

document.getElementById('logoInput').addEventListener('change', async (e)=>{
  const file = e.target.files[0];
  if(!file) return;
  const dataUrl = await resizeImage(file, 300);
  applyLogo(dataUrl);
  try{
    await setDoc(doc(db,'settings','branding'), { logoDataUrl: dataUrl }, { merge:true });
  }catch(err){ console.error(err); alert('تعذّر حفظ الشعار على كل الأجهزة، تأكد من الاتصال'); }
});

onSnapshot(doc(db,'settings','branding'), (snap)=>{
  if(snap.exists() && snap.data().logoDataUrl){ applyLogo(snap.data().logoDataUrl); }
});

// ---------------------------------------------------------------
// قوائم الفواتير والمصاريف (تحديث لحظي مباشر - Real-time sync)
// ---------------------------------------------------------------
function renderInvoicesList(){
  const wrap = document.getElementById('invoicesList');
  if(invoicesCache.length === 0){ wrap.innerHTML = '<div class="empty">لا توجد فواتير بعد</div>'; return; }
  wrap.innerHTML = invoicesCache.map(inv=>`
    <div class="list-item">
      <div>
        <div class="main">${inv.invNoStr || ''} — ${inv.customerName || 'بدون اسم'}</div>
        <div class="sub">${inv.date || ''} · ${inv.region || ''} ${inv.state ? '- '+inv.state : ''}</div>
      </div>
      <div class="amt">${(inv.total||0).toFixed(3)} ر.ع</div>
    </div>
  `).join('');
}

function renderExpensesList(){
  const wrap = document.getElementById('expensesList');
  if(expensesCache.length === 0){ wrap.innerHTML = '<div class="empty">لا توجد مصاريف بعد</div>'; return; }
  wrap.innerHTML = expensesCache.map(ex=>`
    <div class="list-item">
      <div>
        <div class="main">${ex.description || 'بدون وصف'}</div>
        <div class="sub">${ex.date || ''} · ${ex.category || ''}</div>
      </div>
      <div class="amt exp">- ${(ex.amount||0).toFixed(3)} ر.ع</div>
    </div>
  `).join('');
}

onSnapshot(query(collection(db,'invoices'), orderBy('createdAt','desc')), (snap)=>{
  invoicesCache = snap.docs.map(d=>d.data());
  renderInvoicesList();
  renderStats();
});

onSnapshot(query(collection(db,'expenses'), orderBy('createdAt','desc')), (snap)=>{
  expensesCache = snap.docs.map(d=>d.data());
  renderExpensesList();
  renderStats();
});

// ---------------------------------------------------------------
// المصاريف - حفظ
// ---------------------------------------------------------------
async function saveExpense(){
  const desc = document.getElementById('expDesc').value.trim();
  const amount = parseFloat(document.getElementById('expAmount').value) || 0;
  const category = document.getElementById('expCategory').value;
  const date = document.getElementById('expDate').value || todayStr();
  if(!desc || amount <= 0){ alert('أدخل وصف ومبلغ صحيح'); return; }
  try{
    await addDoc(collection(db,'expenses'), { description: desc, amount, category, date, createdAt: serverTimestamp() });
    document.getElementById('expDesc').value = '';
    document.getElementById('expAmount').value = '';
    document.getElementById('expDate').value = '';
  }catch(err){
    console.error(err); alert('تعذّر حفظ المصروف، تأكد من الاتصال');
  }
}
document.getElementById('expDate').value = todayStr();

// ---------------------------------------------------------------
// التقارير: اليوم / آخر 7 أيام / هذا الشهر
// ---------------------------------------------------------------
function sumIn(list, field, from, to){
  return list.filter(x => x.date >= from && x.date <= to)
             .reduce((s,x)=> s + (x[field]||0), 0);
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

function renderStats(){
  const t = todayStr();
  const w = daysAgoStr(6);
  const m = monthStartStr();

  document.getElementById('statsToday').innerHTML =
    statCardHTML('اليوم', sumIn(invoicesCache,'total',t,t), sumIn(expensesCache,'amount',t,t), countIn(invoicesCache,t,t));

  document.getElementById('statsWeek').innerHTML =
    statCardHTML('آخر 7 أيام', sumIn(invoicesCache,'total',w,t), sumIn(expensesCache,'amount',w,t), countIn(invoicesCache,w,t));

  document.getElementById('statsMonth').innerHTML =
    statCardHTML('هذا الشهر', sumIn(invoicesCache,'total',m,t), sumIn(expensesCache,'amount',m,t), countIn(invoicesCache,m,t));
}

// ---------------------------------------------------------------
// التهيئة
// ---------------------------------------------------------------
newInvoice();
renderStats();

// إتاحة الدوال للأزرار داخل الـ HTML
window.App = { addRow, delRow, calc, newInvoice, saveInvoice, saveExpense };
