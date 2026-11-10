// Small progressive enhancements. The site works without this file.
(function () {
  'use strict';
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } },
  };

  // "/" focuses search, Esc closes menus.
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
      var q = $('#q');
      if (q) { e.preventDefault(); q.focus(); q.select(); }
    }
    if (e.key === 'Escape') $$('details[open].menu, details[open].pop').forEach(function (d) { d.open = false; });
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && tag === 'textarea' && e.target.form) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  });

  // Close dropdowns when clicking elsewhere.
  document.addEventListener('click', function (e) {
    $$('details[open].menu, details[open].pop').forEach(function (d) {
      if (!d.contains(e.target)) d.open = false;
    });
  });

  // Theme toggle (stored in a cookie so the server renders the right theme).
  var themeButtons = $$('[data-theme-toggle]');
  themeButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var root = document.documentElement;
      var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.cookie = 'theme=' + next + '; Path=/; Max-Age=31536000; SameSite=Lax';
      root.setAttribute('data-theme', next);
      var label = next === 'light' ? 'Switch to dark mode' : 'Switch to light mode';
      themeButtons.forEach(function (toggle) {
        toggle.setAttribute('aria-label', label);
        toggle.title = label;
      });
    });
  });

  function easeTickerHover(ticker, track) {
    if (!track.getAnimations || !window.Animation?.prototype.updatePlaybackRate ||
        !window.matchMedia('(hover: hover)').matches) return;

    var activeAnimation;
    var frame;
    var rate = 1;
    function easeTo(targetRate) {
      cancelAnimationFrame(frame);
      var animation = track.getAnimations().find(function (item) {
        return item.animationName === 'listing-ticker-loop';
      });
      if (!animation) return;
      if (animation !== activeAnimation) {
        activeAnimation = animation;
        rate = animation.playbackRate;
      }
      if (rate === targetRate) return;

      var startRate = rate;
      var startTime = performance.now();
      function step(now) {
        if (animation.playState === 'idle') return;
        var progress = Math.min(1, Math.max(0, (now - startTime) / 320));
        var eased = progress * progress * (3 - 2 * progress);
        rate = startRate + (targetRate - startRate) * eased;
        animation.updatePlaybackRate(rate);
        if (progress < 1) frame = requestAnimationFrame(step);
      }
      frame = requestAnimationFrame(step);
    }

    ticker.classList.add('ticker-eases');
    ticker.addEventListener('pointerenter', function (event) {
      if (event.pointerType !== 'touch') easeTo(0);
    });
    ticker.addEventListener('pointerleave', function (event) {
      if (event.pointerType !== 'touch') easeTo(1);
    });
    track.addEventListener('animationstart', function () {
      if (ticker.matches(':hover')) easeTo(0);
    });
  }

  // Duplicate the listing row so the ticker can wrap without a jump.
  var ticker = $('.hero .blue');
  if (ticker && ticker.children.length > 1) {
    var track = document.createElement('div');
    track.className = 'ticker-track';
    var group = document.createElement('div');
    group.className = 'ticker-group';
    while (ticker.firstChild) group.appendChild(ticker.firstChild);
    var repeat = group.cloneNode(true);
    repeat.setAttribute('aria-hidden', 'true');
    $$('a', repeat).forEach(function (link) { link.tabIndex = -1; });
    track.append(group, repeat);
    ticker.appendChild(track);
    ticker.classList.add('listing-ticker');
    easeTickerHover(ticker, track);
  }

  // Reveal content on entry and reset it only after it leaves the viewport.
  if ('IntersectionObserver' in window && window.matchMedia('(prefers-reduced-motion: no-preference)').matches) {
    var initiallyVisible = new WeakSet();
    // Start inside the viewport so the 28px entrance slide cannot trigger a reset.
    var reveal = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && !initiallyVisible.has(entry.target)) {
          entry.target.classList.add('scroll-reveal');
        }
      });
    }, { rootMargin: '-32px 0px -32px 0px' });
    var resetReveal = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) {
          entry.target.classList.remove('scroll-reveal');
          initiallyVisible.delete(entry.target);
        }
      });
    });
    $$('main .box, main .feat-card, .hero .blue').forEach(function (section) {
      var bounds = section.getBoundingClientRect();
      if (bounds.top < window.innerHeight && bounds.bottom > 0) initiallyVisible.add(section);
      reveal.observe(section);
      resetReveal.observe(section);
    });
  }

  // Confirm dangerous forms, and stop double submits.
  $$('form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var msg = form.getAttribute('data-confirm');
      if (msg && !window.confirm(msg)) { e.preventDefault(); return; }
      if (form.method.toLowerCase() === 'post') {
        var draft = $('[data-draft]', form);
        if (draft) store.del('draft:' + draft.getAttribute('data-draft'));
        setTimeout(function () { $$('button[type="submit"]', form).forEach(function (b) { b.disabled = true; }); }, 0);
      }
    });
  });

  // Selects that submit their form on change (jump menu, status picker).
  $$('select[data-autosubmit]').forEach(function (sel) {
    sel.addEventListener('change', function () { sel.form.requestSubmit(); });
  });

  // Character counters.
  $$('[data-count]').forEach(function (el) {
    var max = Number(el.getAttribute('maxlength'));
    if (!max) return;
    var out = document.createElement('div');
    out.className = 'hint right';
    el.insertAdjacentElement('afterend', out);
    var update = function () {
      var left = max - el.value.length;
      out.textContent = el.value.length ? el.value.length + ' / ' + max : '';
      out.classList.toggle('warn', left < max * 0.1);
    };
    el.addEventListener('input', update);
    update();
  });

  // Draft autosave for textareas.
  $$('textarea[data-draft]').forEach(function (el) {
    var key = 'draft:' + el.getAttribute('data-draft');
    var saved = store.get(key);
    if (saved && !el.value) { el.value = saved; el.dispatchEvent(new Event('input')); }
    var timer;
    el.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () { if (el.value) store.set(key, el.value); else store.del(key); }, 400);
    });
  });

  // Quote a post into the reply box.
  $$('[data-quote]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = document.getElementById(btn.getAttribute('data-quote'));
      var box = $('#reply');
      if (!src || !box) return;
      var selected = String(window.getSelection());
      var text = selected && src.contains(window.getSelection().anchorNode) ? selected : src.innerText;
      text = text.trim().split('\n').filter(function (l) { return l.trim() && l.charAt(0) !== '>'; }).slice(0, 8);
      var quote = '> ' + btn.getAttribute('data-author') + ' wrote:\n' + text.map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
      box.value = (box.value ? box.value.replace(/\s*$/, '\n\n') : '') + quote;
      box.dispatchEvent(new Event('input'));
      box.focus();
      box.scrollIntoView({ block: 'center' });
    });
  });

  // Live preview on the listing form.
  var preview = $('[data-preview]');
  if (preview) {
    var form = preview.closest('form');
    var type = form.elements.listing_type, handle = form.elements.handle, price = form.elements.price, title = form.elements.title;
    var render = function () {
      var h = handle.value.trim().replace(/^@+/, '');
      preview.hidden = !h;
      var opt = type.options[type.selectedIndex];
      var tag = $('[data-preview-type]', preview);
      tag.textContent = opt && opt.value ? opt.getAttribute('data-short') : '';
      tag.className = 'tag ' + (opt ? opt.value : '');
      $('[data-preview-handle]', preview).textContent = '@' + h;
      $('[data-preview-title]', preview).textContent = title.value.trim() || '(title)';
      var n = Number(price.value.replace(/[$,]/g, ''));
      $('[data-preview-price]', preview).textContent =
        price.value.trim() === '' ? ' - Offers' : isFinite(n) && n >= 0 ? ' - $' + n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : ' - (price is not a number)';
    };
    [type, handle, price, title].forEach(function (el) { el.addEventListener('input', render); el.addEventListener('change', render); });
    render();
  }

  // Chats open scrolled to the newest message.
  $$('[data-scroll-end]').forEach(function (el) { el.scrollTop = el.scrollHeight; });

  // "Go back" on error pages.
  $$('[data-back]').forEach(function (btn) {
    btn.addEventListener('click', function () { history.length > 1 ? history.back() : (location.href = '/'); });
  });
})();
