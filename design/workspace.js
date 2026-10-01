/* Isolated design review. No fetch, CRM data, or persistent product writes. */
(() => {
  const products = [
    {id: 1, name: 'Шоколад молочний з цілим фундуком', category: 'Шоколад', pack: 'Плитка · 90 г', cost: 52, price: 79, promo: true},
    {id: 2, name: 'Цукерки «Вечірній Київ»', category: 'Цукерки', pack: 'Коробка · 176 г', cost: 148, price: 199, promo: false},
    {id: 3, name: 'Мармелад фруктовий асорті', category: 'Мармелад', pack: 'Ваговий · 1 кг', cost: 125, price: 179, promo: false},
    {id: 4, name: 'Вода мінеральна негазована', category: 'Напої', pack: 'Пляшка · 0,5 л', cost: 10, price: 17, promo: false},
    {id: 5, name: 'Капучино XL', category: 'Кав’ярня', pack: 'Стакан · 1 шт', cost: 28, price: 49, promo: false},
    {id: 6, name: 'Печиво вівсяне з журавлиною', category: 'Печиво', pack: 'Пакування · 250 г', cost: 43.5, price: 65, promo: true}
  ];
  const $ = selector => document.querySelector(selector);
  const escape = value => String(value).replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
  const money = new Intl.NumberFormat('uk-UA', {minimumFractionDigits: 2, maximumFractionDigits: 2});
  const categories = [...new Set(products.map(product => product.category))].sort((a,b) => a.localeCompare(b,'uk'));
  const options = categories.map(category => `<option>${escape(category)}</option>`).join('');
  $('#category').insertAdjacentHTML('beforeend', options);
  const form = $('#productForm'), editor = $('#editor');
  form.elements.category.innerHTML = options;
  let editId = null, opener = null;
  function render() {
    const search = $('#search').value.trim().toLocaleLowerCase('uk');
    const category = $('#category').value, promotion = $('#promotion').value;
    const list = products.filter(product => product.name.toLocaleLowerCase('uk').includes(search) && (!category || product.category === category) && (promotion === 'all' || product.promo === (promotion === 'promo')));
    $('#productRows').innerHTML = list.map(product => `<tr><td><p class="w-product-name">${escape(product.name)}</p><span class="w-product-meta">${escape(product.category)} · ${escape(product.pack)}</span></td><td class="w-money ui-number" data-label="Закупівля, грн">${money.format(product.cost)}</td><td class="w-money w-price ui-number" data-label="Продаж, грн">${money.format(product.price)}</td><td data-label="Акція">${product.promo ? '<span class="ui-badge">Акція</span>' : '<span class="ui-muted">—<span class="ui-sr-only">Без акції</span></span>'}</td><td class="w-action"><button class="ui-button" type="button" data-edit="${product.id}" aria-label="Редагувати ${escape(product.name)}">Редагувати</button></td></tr>`).join('');
    $('.w-table').hidden = list.length === 0;
    $('#empty').hidden = list.length !== 0;
    $('#result').textContent = `Показано ${list.length} із ${products.length} товарів`;
  }
  function openEditor(product, button) {
    editId = product?.id ?? null; opener = button;
    $('#editorTitle').textContent = product ? 'Редагувати товар' : 'Новий товар';
    form.reset();
    for (const key of ['name', 'category', 'pack', 'cost', 'price']) form.elements[key].value = product?.[key] ?? (['cost','price'].includes(key) ? '' : key === 'category' ? categories[0] : '');
    form.elements.promo.checked = product?.promo ?? false;
    $('#editorError').textContent = '';
    editor.showModal(); form.elements.name.focus({preventScroll: true});
  }
  $('#filters').addEventListener('submit', event => event.preventDefault());
  $('#search').addEventListener('input', render);
  $('#category').addEventListener('change', render);
  $('#promotion').addEventListener('change', render);
  $('#resetFilters').addEventListener('click', () => {$('#filters').reset(); render(); $('#search').focus();});
  $('#productRows').addEventListener('click', event => {
    const button = event.target.closest('[data-edit]');
    if (button) openEditor(products.find(product => product.id === Number(button.dataset.edit)), button);
  });
  $('#newProduct').addEventListener('click', event => openEditor(null, event.currentTarget));
  for (const id of ['closeEditor', 'cancelEditor']) $('#'+id).addEventListener('click', () => editor.close());
  editor.addEventListener('close', () => {
    // Rendering replaces row buttons; recover the corresponding live opener.
    const liveOpener = opener?.isConnected ? opener : document.querySelector(`[data-edit="${editId}"]`);
    (liveOpener || $('#newProduct')).focus({preventScroll: true});
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const name = form.elements.name.value.trim(), pack = form.elements.pack.value.trim();
    if (!name || !pack) {
      $('#editorError').textContent = 'Введіть назву товару та пакування.';
      form.elements[name ? 'pack' : 'name'].focus(); return;
    }
    const product = {id: editId ?? Math.max(...products.map(item => item.id)) + 1, name, pack, category: form.elements.category.value, cost: Number(form.elements.cost.value), price: Number(form.elements.price.value), promo: form.elements.promo.checked};
    const index = products.findIndex(item => item.id === editId);
    if (index >= 0) products[index] = product; else products.push(product);
    render(); editor.close();
  });
  render();
})();
