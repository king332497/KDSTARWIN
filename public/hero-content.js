(() => {
  'use strict';

  const $ = (selector, root=document) => root.querySelector(selector);
  let applying = false;

  const nodes = () => ({
    root: $('.hero-campaign-v6'),
    image: $('.hero-campaign-v6 .campaign-card-v6 img'),
    chipOneTitle: $('.hero-campaign-v6 .campaign-chip-v6.one strong'),
    chipOneSubtitle: $('.hero-campaign-v6 .campaign-chip-v6.one small'),
    chipTwoTitle: $('.hero-campaign-v6 .campaign-chip-v6.two strong'),
    chipTwoSubtitle: $('.hero-campaign-v6 .campaign-chip-v6.two small'),
    caption: $('.hero-campaign-v6 .campaign-caption-v6')
  });

  const setText = (el, value) => {
    if (!el || typeof value !== 'string') return;
    el.textContent = value;
    el.hidden = value.trim() === '';
  };

  async function applyHeroContent() {
    if (applying) return;
    const n = nodes();
    if (!n.root) return;

    applying = true;
    try {
      const response = await fetch('/api/public/hero', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Accept':'application/json' }
      });
      if (!response.ok) return;
      const data = await response.json();
      const hero = data?.hero;
      if (!hero) return;

      setText(n.chipOneTitle, hero.chip_one_title);
      setText(n.chipOneSubtitle, hero.chip_one_subtitle);
      setText(n.chipTwoTitle, hero.chip_two_title);
      setText(n.chipTwoSubtitle, hero.chip_two_subtitle);
      setText(n.caption, hero.caption);

      if (n.image && hero.image_alt) n.image.alt = hero.image_alt;

      if (n.image && hero.image_url) {
        const next = new Image();
        next.decoding = 'async';
        next.onload = () => {
          n.image.style.transition = 'opacity .22s ease';
          n.image.style.opacity = '0';
          requestAnimationFrame(() => {
            n.image.src = hero.image_url;
            n.image.alt = hero.image_alt || n.image.alt;
            requestAnimationFrame(() => { n.image.style.opacity = '1'; });
          });
        };
        next.src = hero.image_url;
      }
    } catch {
      // Keep the built-in visual untouched when the content service is unavailable.
    } finally {
      applying = false;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyHeroContent, { once:true });
  } else {
    applyHeroContent();
  }

  window.addEventListener('kb:hero-content-updated', applyHeroContent);
})();
