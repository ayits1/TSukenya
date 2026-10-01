/* Editable choice of an existing record; DOM focus stays in the input. */
(() => {
  const instances = new WeakMap();
  let expanded = null;
  const normalize = value => String(value).normalize('NFKC').toLocaleLowerCase('uk-UA').trim();
  class Combo {
    constructor(host, config) {
      this.host = host;
      this.onChange = config.onChange;
      this.options = [];
      this.results = [];
      this.active = -1;
      this.value = null;
      host.classList.add('ui-combo');
      this.input = document.createElement('input');
      Object.assign(this.input, {id:config.id, name:config.id, type:'text', autocomplete:'off', spellcheck:false, placeholder:'Знайти товар…', className:'ui-input'});
      for (const [key,value] of Object.entries({role:'combobox','aria-autocomplete':'list','aria-haspopup':'listbox','aria-expanded':'false','aria-controls':config.id+'List'})) this.input.setAttribute(key,value);
      this.toggle = document.createElement('button');
      Object.assign(this.toggle,{type:'button',tabIndex:-1,className:'ui-combo-toggle'});
      this.toggle.setAttribute('aria-label','Відкрити список товарів');
      this.toggle.setAttribute('aria-controls',config.id+'List');
      this.toggle.setAttribute('aria-expanded','false');
      this.toggle.innerHTML='<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      this.popup = document.createElement('div');
      this.popup.className='ui-combo-popup';this.popup.hidden=true;
      this.list = document.createElement('ul');
      this.list.id=config.id+'List';this.list.setAttribute('role','listbox');this.list.setAttribute('aria-label','Товари для перегляду');
      this.note = document.createElement('p');this.note.className='ui-combo-note';this.note.hidden=true;
      this.status = document.createElement('span');this.status.className='ui-sr-only';this.status.setAttribute('role','status');this.status.setAttribute('aria-live','polite');
      this.popup.append(this.list,this.note);host.append(this.input,this.toggle,this.popup,this.status);
      this.input.addEventListener('click',()=>{if(!this.isOpen){this.open('');this.input.select();}});
      this.input.addEventListener('input',()=>this.open(this.input.value,true));
      this.input.addEventListener('keydown',event=>this.key(event));
      this.toggle.addEventListener('mousedown',event=>event.preventDefault());
      this.toggle.addEventListener('click',()=>{if(this.isOpen)this.close();else{this.input.focus({preventScroll:true});this.open('');this.input.select();}});
      this.list.addEventListener('mousedown',event=>event.preventDefault());
      this.list.addEventListener('click',event=>{const item=event.target.closest('[role=option]');if(item)this.choose(Number(item.dataset.index));});
      host.addEventListener('focusout',event=>{if(!host.contains(event.relatedTarget))this.close();});
    }
    get isOpen(){return !this.popup.hidden;}
    update(options,value) {
      this.options=options;this.value=value;
      const selected=options.find(item=>item.value===value);
      this.input.dataset.value=selected?.value||'';
      this.input.disabled=this.toggle.disabled=!options.length;
      if(!this.isOpen)this.input.value=selected?.label||'';
      else this.open(this.input.value,true);
    }
    open(query,typing=false) {
      if(this.input.disabled)return;
      if(expanded&&expanded!==this)expanded.close();expanded=this;
      const terms=normalize(query).split(/\s+/).filter(Boolean);
      const matches=this.options.filter(item=>terms.every(term=>normalize(item.label).includes(term)));
      this.results=matches.slice(0,60);this.active=typing&&this.results.length?0:-1;
      const fragment=document.createDocumentFragment();
      this.results.forEach((item,index)=>{
        const li=document.createElement('li');li.textContent=item.label;li.id=this.input.id+'Option'+index;li.dataset.index=index;
        li.setAttribute('role','option');li.setAttribute('aria-selected','false');fragment.append(li);
      });
      this.list.replaceChildren(fragment);
      this.note.hidden=matches.length>0&&matches.length<=60;
      this.note.textContent=matches.length?`Перші 60 із ${matches.length}. Уточніть назву для пошуку.`:'Товарів не знайдено. Спробуйте іншу назву.';
      this.status.textContent=matches.length?`Знайдено товарів: ${matches.length}`:'Товарів не знайдено';
      this.popup.hidden=false;this.input.setAttribute('aria-expanded','true');this.toggle.setAttribute('aria-expanded','true');
      this.mark();this.place();this.popup.scrollTop=0;
    }
    place() {
      if(!this.isOpen)return;
      const rect=this.input.getBoundingClientRect(),viewport=window.visualViewport,top=viewport?.offsetTop||0,height=viewport?.height||innerHeight;
      const below=top+height-rect.bottom-12,above=rect.top-top-12,up=below<160&&above>below;
      this.host.classList.toggle('ui-combo-above',up);
      this.popup.style.maxHeight=Math.max(80,Math.min(320,up?above:below))+'px';
    }
    mark() {
      [...this.list.children].forEach((li,index)=>li.setAttribute('aria-selected',String(index===this.active)));
      const item=this.list.children[this.active];
      if(item)this.input.setAttribute('aria-activedescendant',item.id);else this.input.removeAttribute('aria-activedescendant');
    }
    choose(index) {
      const item=this.results[index];if(!item)return;
      const changed=item.value!==this.value;this.value=item.value;this.input.dataset.value=item.value;
      this.close();this.input.focus({preventScroll:true});
      if(changed)this.onChange(item.value);
    }
    close() {
      this.popup.hidden=true;this.input.setAttribute('aria-expanded','false');this.toggle.setAttribute('aria-expanded','false');this.input.removeAttribute('aria-activedescendant');
      this.input.value=this.options.find(item=>item.value===this.value)?.label||'';
      if(expanded===this)expanded=null;
    }
    key(event) {
      if(event.isComposing)return;
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){
        event.preventDefault();if(!this.isOpen)this.open('');
        const direction=event.key==='ArrowDown'?1:-1;
        this.active=this.active<0?(direction===1?0:this.results.length-1):Math.max(0,Math.min(this.results.length-1,this.active+direction));
        this.mark();this.list.children[this.active]?.scrollIntoView({block:'nearest'});return;
      }
      if(event.key==='Enter'&&this.isOpen){event.preventDefault();this.choose(this.active<0?0:this.active);return;}
      if(event.key==='Escape'&&this.isOpen){event.preventDefault();event.stopPropagation();this.close();return;}
      if(event.key==='Tab')this.close();
    }
  }
  document.addEventListener('pointerdown',event=>{if(expanded&&!expanded.host.contains(event.target))expanded.close();});
  const reposition=()=>expanded?.place();window.addEventListener('resize',reposition);window.visualViewport?.addEventListener('resize',reposition);
  window.addEventListener('hashchange',()=>expanded?.close());
  window.PortalCombo={mount(host,config){let instance=instances.get(host);if(!instance){instance=new Combo(host,config);instances.set(host,instance);}instance.update(config.options,config.value);return instance;}};
})();
