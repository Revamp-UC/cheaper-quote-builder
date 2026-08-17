function slide(btn,dir){
  const rail = btn.parentElement.querySelector('.rail');
  rail.scrollBy({left: dir*(rail.clientWidth*0.85), behavior:'smooth'});
}
document.querySelectorAll('.rail').forEach(rail => {
  let wrap = rail.parentElement; if(!wrap.classList.contains('railwrap')){const w=document.createElement('div');w.className='railwrap';rail.replaceWith(w);w.appendChild(rail);wrap=w;}
  const update = () => {
    wrap.classList.toggle('can-left', rail.scrollLeft > 4);
    wrap.classList.toggle('can-right', rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 4);
  };
  rail.addEventListener('scroll', update, {passive:true});
  new ResizeObserver(update).observe(rail);
  update();
  // drag-to-scroll (mouse). Vertical wheel is untouched -> page scrolls naturally.
  let down=false, startX=0, startL=0, moved=false;
  rail.addEventListener('pointerdown', e => {
    if(e.pointerType!=='mouse') return;          // touch already scrolls natively
    down=true; moved=false; startX=e.clientX; startL=rail.scrollLeft;
  });
  window.addEventListener('pointermove', e => {
    if(!down) return;
    const dx = e.clientX - startX;
    if(Math.abs(dx) > 5){ moved=true; rail.classList.add('dragging'); }
    if(moved) rail.scrollLeft = startL - dx;
  });
  window.addEventListener('pointerup', () => {
    down=false; rail.classList.remove('dragging');
  });
  rail.addEventListener('click', e => { if(moved){ e.preventDefault(); e.stopPropagation(); } }, true);
});

/* ---- block ---- */

const q = document.getElementById('q'), cheapOnly = document.getElementById('cheapOnly'),
      resCount = document.getElementById('resCount'),
      allRows = Array.from(document.querySelectorAll('.row'));
function applyFilters(){
  const term = q.value.trim().toLowerCase();
  const cheap = cheapOnly.checked;
  document.body.classList.toggle('cheap-mode', cheap);
  let shown = 0;
  allRows.forEach(row => {
    const matchesSearch = !term || row.dataset.search.includes(term);
    const hasCheaper = parseInt(row.dataset.cheaper) > 0;
    const visible = matchesSearch && (!cheap || hasCheaper);
    row.classList.toggle('hidden', !visible);
    if(visible) shown++;
  });
  resCount.textContent = (term || cheap) ? shown + ' of ' + allRows.length + ' panels' : '';
}
q.addEventListener('input', applyFilters);
cheapOnly.addEventListener('change', applyFilters);

/* ---- block ---- */

// counter on EVERY row: total matches + cheaper count
function refreshCounts(){
  const cheapMode = document.getElementById('cheapOnly')?.checked;
  document.querySelectorAll('.row').forEach(row=>{
    const rail = row.querySelector('.rail');
    if(!rail) return;                         // "unique design" rows: no counter
    let wrap = rail.parentElement; if(!wrap.classList.contains('railwrap')){const w=document.createElement('div');w.className='railwrap';rail.replaceWith(w);w.appendChild(rail);wrap=w;}
    let c = wrap.querySelector('.count');
    if(!c){ c = document.createElement('span'); c.className='count'; wrap.appendChild(c); }
    const total = rail.querySelectorAll('.card').length;
    const cheap = rail.querySelectorAll('.card.is-cheaper').length;
    c.textContent = cheapMode ? (cheap+' cheaper shown of '+total+' matches')
                              : (total+' matches · '+cheap+' cheaper');
  });
}
refreshCounts();
document.getElementById('cheapOnly')?.addEventListener('change', refreshCounts);
