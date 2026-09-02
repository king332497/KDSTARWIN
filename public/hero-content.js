(() => {
  'use strict';

  const $ = (selector, root=document) => root.querySelector(selector);
  let applying = false;
  let slideTimer = null;
  let slideIndex = 0;
  let currentUrls = [];
  let slideshowVersion = 0;

  const FALLBACK_SLIDES = [
    '/assets/hero/kbstar-pinjaman-digital.png',
    '/assets/hero/kbstar-pinjaman-berhasil.png',
    '/assets/hero/kb-bank-lps.png'
  ];

  const nodes = () => ({
    root: $('.hero-campaign-v6'),
    card: $('.hero-campaign-v6 .campaign-card-v6'),
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
        padding: 0 !important;
        margin: 0 !important;
        background: transparent !important;
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
        margin: 0 !important;
        padding: 0 !important;
        aspect-ratio: auto !important;
        object-fit: cover !important;
        object-position: center center !important;
        background: transparent !important;
        backface-visibility: visible !important;
        transform: none !important;
        opacity: 1;
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

  const ensureHeroImage = (n) => {
    if (n.image) return n.image;
    if (!n.card) return null;

    const image = document.createElement('img');
    image.alt = 'Informasi layanan KB Bank';
    image.decoding = 'async';
    image.fetchPriority = 'high';
    n.card.appendChild(image);
    return image;
  };

  const uniqueUrls = (urls) => [...new Set(urls.filter(Boolean))];

  const startSlideshow = (image, urls, imageAlt, intervalMs = 5500) => {
    if (!image) return;

    const version = ++slideshowVersion;
    clearInterval(slideTimer);
    slideTimer = null;
    slideIndex = 0;
    currentUrls = uniqueUrls(urls.length ? urls : FALLBACK_SLIDES);

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const transitionDuration = reduceMotion ? 0 : 210;

    const showSlide = (index) => {
      if (!currentUrls.length) return;

      slideIndex = index % currentUrls.length;
      const requestedUrl = currentUrls[slideIndex];
      const localFallback = FALLBACK_SLIDES[slideIndex % FALLBACK_SLIDES.length];
      const preload = new Image();
      preload.decoding = 'async';

      const commit = (url) => {
        if (version !== slideshowVersion) return;
        image.style.transition = reduceMotion ? 'none' : 'opacity .38s ease';
        if (!reduceMotion) image.style.opacity = '0';

        window.setTimeout(() => {
          if (version !== slideshowVersion) return;
          image.src = url;
          image.alt = imageAlt || 'Informasi layanan KB Bank';
          image.style.opacity = '1';
        }, transitionDuration);
      };

      preload.onload = () => commit(requestedUrl);
      preload.onerror = () => {
        if (version !== slideshowVersion || requestedUrl === localFallback) return;
        startSlideshow(image, FALLBACK_SLIDES, imageAlt, intervalMs);
      };
      preload.src = requestedUrl;
    };

    showSlide(0);
    if (currentUrls.length > 1 && !reduceMotion) {
      slideTimer = window.setInterval(
        () => showSlide((slideIndex + 1) % currentUrls.length),
        Math.max(3500, Number(intervalMs) || 5500)
      );
    }
  };


  installHeroStaticFit();

  async function applyHeroContent() {
    if (applying) return;
    const n = nodes();
    if (!n.root) return;

    const image = ensureHeroImage(n);
    startSlideshow(image, FALLBACK_SLIDES, 'Informasi layanan KB Bank');

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

      const apiUrls = Array.isArray(hero.image_urls) && hero.image_urls.length
        ? hero.image_urls
        : (hero.image_url ? [hero.image_url] : []);

      startSlideshow(image, apiUrls, hero.image_alt, hero.slideshow_interval_ms);
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
