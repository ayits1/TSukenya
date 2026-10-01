/* One control layer for legacy portal and accounting modules. */
(() => {
  function upgrade(root) {
    const nodes = root.querySelectorAll?.('button.btn,a.btn,input,select,textarea') || [];
    for (const node of nodes) {
      if(node.closest('.tk-root,.tk-editor-overlay,.tk-popover'))continue; // React Aria owns these controls.
      if (node.matches('.btn')) {
        if (!node.classList.contains('ui-button')) node.classList.add('ui-button');
        if (!node.classList.contains('soft') && !node.classList.contains('danger')) node.classList.add('ui-button--primary');
        if (node.classList.contains('danger')) node.classList.add('ui-button--danger');
      } else if (node.tagName === 'SELECT') {
        if (!node.multiple && node.size <= 1) node.classList.add('ui-select');
      } else if (node.type === 'checkbox' || node.type === 'radio') node.classList.add('ui-checkbox');
      else if (node.type === 'color') node.classList.add('ui-color');
      else if (!['hidden','file','submit','button','range'].includes(node.type)) node.classList.add('ui-input');
    }
    fitPreviews();
  }
  const resize = new ResizeObserver(() => fitPreviews());
  let preview = null;
  function fitPreviews() {
    const current = document.getElementById('individualPreview');
    if (current !== preview) { if(preview)resize.unobserve(preview);preview=current;if(preview)resize.observe(preview); }
    const tag=preview?.querySelector('.tag');
    if(tag)tag.style.zoom=Math.max(.45,Math.min(2,(preview.clientWidth-24)/tag.offsetWidth));
    const pages=document.getElementById('printPages');
    if(pages)for(const page of pages.querySelectorAll('.print-page'))page.style.zoom=Math.min(1,(pages.clientWidth-24)/page.offsetWidth);
  }
  upgrade(document);
  // Only child-list changes are observed: adding control classes cannot loop.
  new MutationObserver(changes => {
    const roots=new Set();
    for(const change of changes)if(change.target instanceof Element)roots.add(change.target);
    for(const root of roots)upgrade(root);
  }).observe(document.body,{childList:true,subtree:true});
  const toggle=document.getElementById('navToggle');
  toggle?.addEventListener('click',()=>{
    const open=toggle.getAttribute('aria-expanded')!=='true';
    toggle.setAttribute('aria-expanded',String(open));document.body.classList.toggle('nav-open',open);
  });
  document.getElementById('portalSidebar')?.addEventListener('click',event=>{
    if(event.target.closest('a')){document.body.classList.remove('nav-open');toggle.setAttribute('aria-expanded','false');}
  });
  window.addEventListener('resize',fitPreviews);
  window.addEventListener('keydown',event=>{if(event.key==='Escape'&&document.body.classList.contains('nav-open')){document.body.classList.remove('nav-open');toggle.setAttribute('aria-expanded','false');toggle.focus();}});
})();
