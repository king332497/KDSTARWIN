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


  const installHeroMotion = () => {
    if (document.getElementById('kbHeroMotionStyle')) return;

    const style = document.createElement('style');
    style.id = 'kbHeroMotionStyle';
    style.textContent = `
      @keyframes kbHeroFloatPremium {
        0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
        50% { transform: translate3d(0, -9px, 0) scale(1.012); }
      }

      @keyframes kbHeroChipFloatOne {
        0%, 100% { transform: translate3d(0, 0, 0); }
        50% { transform: translate3d(0, -5px, 0); }
      }

      @keyframes kbHeroChipFloatTwo {
        0%, 100% { transform: translate3d(0, 0, 0); }
        50% { transform: translate3d(0, 6px, 0); }
      }

      @keyframes kbHeroCaptionFloat {
        0%, 100% { transform: translate3d(0, 0, 0); }
        50% { transform: translate3d(4px, -3px, 0); }
      }

      .hero-campaign-v6 .campaign-card-v6 {
        will-change: transform;
        transform-origin: 50% 52%;
        animation: kbHeroFloatPremium 7s cubic-bezier(.45,.05,.55,.95) infinite;
      }

      .hero-campaign-v6 .campaign-chip-v6.one {
        will-change: transform;
        animation: kbHeroChipFloatOne 5.8s ease-in-out .35s infinite;
      }

      .hero-campaign-v6 .campaign-chip-v6.two {
        will-change: transform;
        animation: kbHeroChipFloatTwo 6.6s ease-in-out .8s infinite;
      }

      .hero-campaign-v6 .campaign-caption-v6 {
        will-change: transform;
        animation: kbHeroCaptionFloat 7.4s ease-in-out .2s infinite;
      }

      .hero-campaign-v6 .campaign-card-v6 img {
        backface-visibility: hidden;
        transform: translateZ(0);
      }

      @media (max-width: 520px) {
        @keyframes kbHeroFloatPremium {
          0%, 100% { transform: translate3d(0, 0, 0) scale(1); }
          50% { transform: translate3d(0, -6px, 0) scale(1.008); }
        }

        .hero-campaign-v6 .campaign-chip-v6.one,
        .hero-campaign-v6 .campaign-chip-v6.two {
          animation-duration: 7s;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .hero-campaign-v6 .campaign-card-v6,
        .hero-campaign-v6 .campaign-chip-v6.one,
        .hero-campaign-v6 .campaign-chip-v6.two,
        .hero-campaign-v6 .campaign-caption-v6 {
          animation: none !important;
          transform: none !important;
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

  installHeroMotion();

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
            n.image.style.transition=reduceMotion?'none':'opacity .38s ease, transform .38s ease';
            if(!reduceMotion){ n.image.style.opacity='0'; n.image.style.transform='scale(.985)'; }
            setTimeout(()=>{
              n.image.src=url; n.image.alt=hero.image_alt||n.image.alt;
              n.image.style.opacity='1'; n.image.style.transform='scale(1)';
            },reduceMotion?0:210);
          };
          preload.src=url;
        };
        if(currentUrls.length){
          showSlide(0);
          if(currentUrls.length>1 && !reduceMotion){
            const interval=Math.max(3500,Number(hero.slideshow_interval_ms)||5500);
            slideTimer=setInterval(()=>showSlide((slideIndex+1)%currentUrls.length),interval);
          }
        }
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
