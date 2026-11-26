(function () {
  try {
    var t = localStorage.getItem('pb-theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    var f = localStorage.getItem('pb-font');
    if (f === 'instrument') document.documentElement.setAttribute('data-font', 'instrument');
  } catch (e) {}
})();
