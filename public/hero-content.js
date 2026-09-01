(() => {
  'use strict';

  const $ = (selector, root=document) => root.querySelector(selector);
  let applying = false;
  let slideTimer = null;
  let slideIndex = 0;
  let currentUrls = [];

  const nodes = () => ({
    root: $('.hero-campaign-v6'),
    image: $('.hero-campaign-v6 .campaign-card-v6 img'),
    chipOneTitle: $('.hero-campaign-v6 .campaign-chip-v6.one strong'),
    chipOneSubtitle: $('.hero-campaign-v6 .campaign-chip-v6.one small'),
    chipTwoTitle: $('.hero-campaign-v6 .campaign-chip-v6.two strong'),
    chipTwoSubtitle: $('.hero-campaign-v6 .campaign-chip-v6.two small'),
    caption: $('.hero-campaign-v6 .campaign-caption-v6')
  });


  const installHeroStaticFit = () => {
    document.getElementById('kbHeroMotionStyle')?.remove();
    if (document.getElementById('kbHeroStaticFitStyle')) return;

    const style = document.createElement('style');
    style.id = 'kbHeroStaticFitStyle';
    style.textContent = `
      /* Hero visual bersih: tanpa background ungu dan tanpa animasi gerak lama. */
      .hero-campaign-v6::before,
      .hero-campaign-v6::after {
        content: none !important;
        display: none !important;
        background: none !important;
        box-shadow: none !important;
        transform: none !important;
        animation: none !important;
      }

      .hero-campaign-v6 {
        background: transparent !important;
        animation: none !important;
        transform: none !important;
      }

      .hero-campaign-v6 .campaign-card-v6 {
        animation: none !important;
        transform: none !important;
        aspect-ratio: 4 / 5 !important;
        overflow: hidden !important;
      }

      .hero-campaign-v6 .campaign-chip-v6,
      .hero-campaign-v6 .campaign-chip-v6.one,
      .hero-campaign-v6 .campaign-chip-v6.two,
      .hero-campaign-v6 .campaign-caption-v6 {
        animation: none !important;
        transform: none !important;
      }

      .hero-campaign-v6 .campaign-card-v6 img {
        display: block !important;
        width: 100% !important;
        height: 100% !important;
        max-width: 100% !important;
        max-height: 100% !important;
        aspect-ratio: auto !important;
        object-fit: contain !important;
        object-position: center center !important;
        background: #fff !important;
        backface-visibility: visible !important;
        transform: none !important;
      }

      @media (max-width: 620px) {
        .hero-campaign-v6 .campaign-card-v6 {
          aspect-ratio: 4 / 5 !important;
        }
      }
    `;

    document.head.appendChild(style);
  };

  const setText = (el, value) => {
    if (!el || typeof value !== 'string') return;
    el.textContent = value;
    el.hidden = value.trim() === '';
  };


  installHeroStaticFit();

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

      if (n.image) {
        clearInterval(slideTimer); slideTimer=null; slideIndex=0;
        currentUrls=(Array.isArray(hero.image_urls)&&hero.image_urls.length ? hero.image_urls : (hero.image_url?[hero.image_url]:[])).filter(Boolean);
        const reduceMotion=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const showSlide = index => {
          if(!currentUrls.length) return;
          slideIndex=index%currentUrls.length;
          const url=currentUrls[slideIndex];
          const preload=new Image(); preload.decoding='async';
          preload.onload=()=>{
            n.image.style.transition=reduceMotion?'none':'opacity .38s ease';
            if(!reduceMotion){ n.image.style.opacity='0'; }
            setTimeout(()=>{
              n.image.src=url; n.image.alt=hero.image_alt||n.image.alt;
              n.image.style.opacity='1';
            },reduceMotion?0:210);
          };
          preload.src=url;
        };
        if(currentUrls.length){
          const card = n.image.closest('.campaign-card-v6');
          if (card) card.hidden = false;
          n.image.hidden = false;
          showSlide(0);
          if(currentUrls.length>1 && !reduceMotion){
            const interval=Math.max(3500,Number(hero.slideshow_interval_ms)||5500);
            slideTimer=setInterval(()=>showSlide((slideIndex+1)%currentUrls.length),interval);
          }
        }
      }
    } catch {
      // No legacy fallback image: leave the dynamic Hero stage empty.
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
