function showToast(msg, type) {
  var kind = type || 'primary';
  var el = document.createElement('div');
  el.className = 'toast show toast-' + kind;
  el.innerHTML = '<span class="toast-message"></span>';
  el.querySelector('.toast-message').textContent = msg;
  var host = document.getElementById('toastContainer') || document.body;
  host.appendChild(el);
  setTimeout(function () { el.remove(); }, 3500);
}

function confirmAction(msg) { return confirm(msg); }

// V6.2 centered searchable selector used by Product, Customer and Supplier fields.
// The native select remains the real form value, so existing routes keep working.
(function () {
  var state = { select:null, type:'product', items:[], activeIndex:-1, controller:null, timer:null };

  function esc(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function ensureOverlay() {
    if (document.getElementById('smartPickerOverlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'smartPickerOverlay';
    overlay.className = 'smart-picker-overlay d-none';
    overlay.innerHTML = '' +
      '<div class="smart-picker-panel" role="dialog" aria-modal="true">' +
        '<div class="smart-picker-header">' +
          '<div><h5 class="mb-0" id="smartPickerTitle">Select</h5><div class="small text-muted" id="smartPickerHint">Search or show all</div></div>' +
          '<button type="button" class="btn-close" id="smartPickerClose" aria-label="Close"></button>' +
        '</div>' +
        '<div class="smart-picker-search-row">' +
          '<div class="input-group"><span class="input-group-text"><i class="bi bi-search"></i></span><input id="smartPickerSearch" class="form-control" autocomplete="off" placeholder="Search..."><button class="btn btn-outline-secondary" type="button" id="smartPickerShowAll">Show all</button></div>' +
        '</div>' +
        '<div id="smartPickerResults" class="smart-picker-results"></div>' +
        '<div class="smart-picker-footer"><span id="smartPickerCount" class="small text-muted"></span><span class="small text-muted">↑ ↓ Enter to choose · Esc to close</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.getElementById('smartPickerClose').addEventListener('click', closePicker);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) closePicker(); });
    document.getElementById('smartPickerShowAll').addEventListener('click', function () { document.getElementById('smartPickerSearch').value=''; runSearch(true); });
    document.getElementById('smartPickerSearch').addEventListener('input', function () {
      clearTimeout(state.timer); state.timer = setTimeout(function(){ runSearch(false); }, 130);
    });
    document.getElementById('smartPickerSearch').addEventListener('keydown', function (e) {
      var buttons = document.querySelectorAll('#smartPickerResults .smart-picker-result');
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); return; }
      if (e.key === 'ArrowDown' && buttons.length) { e.preventDefault(); state.activeIndex = Math.min(buttons.length - 1, state.activeIndex + 1); }
      else if (e.key === 'ArrowUp' && buttons.length) { e.preventDefault(); state.activeIndex = Math.max(0, state.activeIndex - 1); }
      else if (e.key === 'Enter' && buttons.length) { e.preventDefault(); chooseItem(state.items[Math.max(0, state.activeIndex)]); return; }
      buttons.forEach(function(b,i){ b.classList.toggle('active', i === state.activeIndex); });
      if (state.activeIndex >= 0 && buttons[state.activeIndex]) buttons[state.activeIndex].scrollIntoView({block:'nearest'});
    });
  }
  function typeConfig(type) {
    if (type === 'customer') return { title:'Select Customer', hint:'Search customer name or phone number', endpoint:'/pos/customers/search', key:'customers' };
    if (type === 'supplier') return { title:'Select Dealer / Supplier', hint:'Search supplier name, phone or email', endpoint:'/api/supplier-search', key:'suppliers' };
    return { title:'Select Product', hint:'Search name, Product Code, Barcode, Unit Code or Serial Number', endpoint:'/api/product-search', key:'products' };
  }
  function itemFromOption(o, type) {
    var text = String(o.textContent || '').trim();
    return {
      id:o.value,
      name:o.dataset.name || text.split(' · ')[0].trim(),
      product_code:o.dataset.code || '', barcode:o.dataset.barcode || '', stock_qty:o.dataset.stock || '', tracking_mode:o.dataset.tracking || '', buy_price:o.dataset.price || '',
      phone:o.dataset.phone || '', email:o.dataset.email || '',
      _optionText:text, _local:true, _type:type
    };
  }
  function localResults(select, q, type) {
    q = String(q || '').trim().toLowerCase();
    return Array.from(select.options).filter(function(o){
      if (!o.value) return false;
      var hay = [o.textContent,o.dataset.name,o.dataset.code,o.dataset.barcode,o.dataset.phone,o.dataset.email,o.dataset.unit,o.dataset.serial].join(' ').toLowerCase();
      return !q || hay.includes(q);
    }).map(function(o){ return itemFromOption(o,type); });
  }
  function displayText(item, type) {
    if (!item) return '';
    if (type === 'customer') return item.name + (item.phone ? ' · ' + item.phone : '');
    if (type === 'supplier') return item.name + (item.phone ? ' · ' + item.phone : '');
    return item.name + ' · ' + (item.product_code || '-');
  }
  function resultHtml(item, type, index) {
    var main = '<strong>' + esc(item.name || '-') + '</strong>';
    var code = '', meta = [];
    if (type === 'product') {
      code = '<code>' + esc(item.product_code || '-') + '</code>';
      if (item.barcode) meta.push('Barcode ' + item.barcode);
      if (item.matched_unit_code) meta.push('Unit ' + item.matched_unit_code);
      if (item.matched_serial) meta.push('Serial ' + item.matched_serial);
      if (!meta.length) meta.push([item.brand,item.model].filter(Boolean).join(' · '));
      return '<button type="button" class="smart-picker-result" data-index="'+index+'"><span class="smart-picker-main">'+main+code+'</span><span class="smart-picker-sub">'+esc(meta.filter(Boolean).join(' · '))+'</span><span class="smart-picker-badge">Stock '+esc(item.stock_qty == null ? '-' : item.stock_qty)+'</span></button>';
    }
    if (item.phone) meta.push(item.phone);
    if (item.email) meta.push(item.email);
    return '<button type="button" class="smart-picker-result" data-index="'+index+'"><span class="smart-picker-main">'+main+'</span><span class="smart-picker-sub">'+esc(meta.join(' · ') || 'No contact details')+'</span></button>';
  }
  function render(items) {
    state.items = items || []; state.activeIndex = -1;
    var box = document.getElementById('smartPickerResults');
    var count = document.getElementById('smartPickerCount');
    var emptyLabel = state.select && state.select.dataset.emptyLabel;
    var emptyButton = emptyLabel ? '<button type="button" class="smart-picker-result smart-picker-empty-choice" data-empty="1"><span class="smart-picker-main"><strong>'+esc(emptyLabel)+'</strong></span><span class="smart-picker-sub">No saved customer selected</span></button>' : '';
    if (!state.items.length) {
      box.innerHTML = emptyButton + '<div class="smart-picker-no-results">No matching result.</div>';
      count.textContent = '0 result';
    } else {
      box.innerHTML = emptyButton + state.items.map(function(item,i){ return resultHtml(item,state.type,i); }).join('');
      count.textContent = state.items.length + (state.items.length === 1 ? ' result' : ' results');
    }
    var empty = box.querySelector('[data-empty="1"]');
    if (empty) empty.addEventListener('click', function(){ chooseEmpty(); });
    box.querySelectorAll('.smart-picker-result[data-index]').forEach(function(btn){ btn.addEventListener('click', function(){ chooseItem(state.items[Number(btn.dataset.index)]); }); });
  }
  function runSearch(showAll) {
    if (!state.select) return;
    var q = showAll ? '' : document.getElementById('smartPickerSearch').value.trim();
    var cfg = typeConfig(state.type);
    if (state.select.dataset.restrictOptions === '1') return render(localResults(state.select,q,state.type));
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    document.getElementById('smartPickerResults').innerHTML = '<div class="smart-picker-loading"><span class="spinner-border spinner-border-sm"></span> Loading...</div>';
    fetch(cfg.endpoint + '?q=' + encodeURIComponent(q) + '&show_all=1', {signal:state.controller.signal})
      .then(function(r){ return r.json(); })
      .then(function(d){
        var items = d && d.success !== false ? (d[cfg.key] || (Array.isArray(d) ? d : [])) : [];
        render(items.length ? items : localResults(state.select,q,state.type));
      })
      .catch(function(e){ if (e.name !== 'AbortError') render(localResults(state.select,q,state.type)); });
  }
  function setOptionData(o, item, type) {
    o.dataset.name = item.name || '';
    if (type === 'product') {
      o.dataset.code=item.product_code||'';o.dataset.barcode=item.barcode||'';o.dataset.stock=item.stock_qty==null?'':item.stock_qty;o.dataset.tracking=item.tracking_mode||'';o.dataset.price=item.buy_price==null?'':item.buy_price;o.dataset.unit=item.matched_unit_code||'';o.dataset.serial=item.matched_serial||'';
    } else { o.dataset.phone=item.phone||'';o.dataset.email=item.email||''; }
  }
  function chooseItem(item) {
    if (!state.select || !item) return;
    var select = state.select, type = state.type;
    var o = Array.from(select.options).find(function(x){ return String(x.value) === String(item.id); });
    if (!o && select.dataset.restrictOptions === '1') return;
    if (!o) { o=document.createElement('option');o.value=item.id;select.appendChild(o); }
    o.textContent = item._optionText || displayText(item,type) + (type==='product' ? ' (Stock '+(item.stock_qty||0)+')' : '');
    setOptionData(o,item,type);
    select.value=String(item.id);
    select.dataset.matchedUnitCode=item.matched_unit_code||'';select.dataset.matchedSerial=item.matched_serial||'';
    if (select._smartDisplay) { select._smartDisplay.value=displayText(item,type);select._smartDisplay.classList.remove('is-invalid'); }
    closePicker();
    select.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function chooseEmpty() {
    if (!state.select) return;
    state.select.value='';
    if (state.select._smartDisplay) state.select._smartDisplay.value=state.select.dataset.emptyLabel || '';
    var s=state.select;closePicker();s.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function openPicker(select,type) {
    ensureOverlay(); state.select=select;state.type=type;state.items=[];state.activeIndex=-1;
    var cfg=typeConfig(type);document.getElementById('smartPickerTitle').textContent=cfg.title;document.getElementById('smartPickerHint').textContent=cfg.hint;
    var search=document.getElementById('smartPickerSearch');search.value='';search.placeholder=cfg.hint;
    document.getElementById('smartPickerOverlay').classList.remove('d-none');document.body.classList.add('smart-picker-open');
    runSearch(true);setTimeout(function(){search.focus();},30);
  }
  function closePicker() {
    var overlay=document.getElementById('smartPickerOverlay');if(overlay)overlay.classList.add('d-none');document.body.classList.remove('smart-picker-open');
    if(state.controller)state.controller.abort();state.controller=null;state.select=null;state.items=[];state.activeIndex=-1;
  }

  function initSelect(select,type) {
    if(!select||select.dataset.smartPickerReady==='1')return;select.dataset.smartPickerReady='1';
    var required=select.required;select.required=false;select.classList.add('smart-picker-source');select.style.display='none';
    var wrap=document.createElement('div');wrap.className='smart-picker-field input-group';select.parentNode.insertBefore(wrap,select);wrap.appendChild(select);
    var input=document.createElement('input');input.type='text';input.className='form-control smart-picker-display';input.readOnly=true;input.placeholder=select.dataset.placeholder||typeConfig(type).hint;wrap.insertBefore(input,select);
    var btn=document.createElement('button');btn.type='button';btn.className='btn btn-outline-secondary smart-picker-open-btn';btn.innerHTML='<i class="bi bi-search"></i>';wrap.appendChild(btn);
    select._smartDisplay=input;select.dataset.wasRequired=required?'1':'0';
    function currentLabel(){var o=select.selectedOptions&&select.selectedOptions[0];if(o&&o.value)return String(o.textContent||'').replace(/\s*\(Stock.*\)$/,'').trim();return select.dataset.emptyLabel||'';}
    input.value=currentLabel();
    input.addEventListener('click',function(){openPicker(select,type)});input.addEventListener('focus',function(){openPicker(select,type)});btn.addEventListener('click',function(){openPicker(select,type)});
    select.addEventListener('change',function(){if(!select.value){input.value=select.dataset.emptyLabel||'';return;}var o=select.selectedOptions[0];if(o)input.value=String(o.textContent||'').replace(/\s*\(Stock.*\)$/,'').trim();});
  }

  window.initProductSearchSelect=function(select){initSelect(select,'product')};
  window.initCustomerSearchSelect=function(select){initSelect(select,'customer')};
  window.initSupplierSearchSelect=function(select){initSelect(select,'supplier')};
  window.initAllSmartSearchSelects=function(scope){
    scope=scope||document;
    scope.querySelectorAll('select.product-search-select').forEach(window.initProductSearchSelect);
    scope.querySelectorAll('select.customer-search-select').forEach(window.initCustomerSearchSelect);
    scope.querySelectorAll('select.supplier-search-select').forEach(window.initSupplierSearchSelect);
  };
  window.initAllProductSearchSelects=window.initAllSmartSearchSelects;

  document.addEventListener('DOMContentLoaded',function(){ensureOverlay();window.initAllSmartSearchSelects(document);});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&document.getElementById('smartPickerOverlay')&&!document.getElementById('smartPickerOverlay').classList.contains('d-none'))closePicker();});
  document.addEventListener('submit',function(e){
    var bad=Array.from(e.target.querySelectorAll('select.smart-picker-source[data-was-required="1"]')).find(function(s){return !s.value;});
    if(bad){e.preventDefault();if(bad._smartDisplay){bad._smartDisplay.classList.add('is-invalid');bad._smartDisplay.focus();}showToast('Please search and select a valid item.','warning');}
  },true);
})();
