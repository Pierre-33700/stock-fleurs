document.getElementById('f').addEventListener('submit', function (e) {
  e.preventDefault();
  var err = document.getElementById('err'), go = document.getElementById('go');
  err.textContent = ''; go.disabled = true;
  fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('pw').value })
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.ok) { location.replace('/'); return; }
      err.textContent = j.error || 'Connexion impossible.';
      go.disabled = false;
    });
  }, function () { err.textContent = 'Connexion impossible. Vérifiez votre réseau.'; go.disabled = false; });
});
