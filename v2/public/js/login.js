document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('loginForm');
  const card = document.getElementById('cardContainer');
  const errBox = document.getElementById('errorAlert');
  const successBox = document.getElementById('successAlert');
  const submitBtn = document.getElementById('submitBtn');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');
  const togglePasswordBtn = document.getElementById('togglePasswordBtn');

  if (togglePasswordBtn && passwordInput) {
    const toggle = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const currentType = passwordInput.getAttribute('type') || 'password';
      const nextType = currentType === 'password' ? 'text' : 'password';
      passwordInput.setAttribute('type', nextType);
      togglePasswordBtn.textContent = nextType === 'password' ? 'Show' : 'Hide';
    };
    togglePasswordBtn.addEventListener('click', toggle);
    togglePasswordBtn.addEventListener('pointerdown', (e) => e.preventDefault());
  }

  function showError(msg) {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.style.display = 'flex';
    if (successBox) successBox.style.display = 'none';
    if (passwordInput) passwordInput.classList.add('input-error');
    if (usernameInput) usernameInput.classList.add('input-error');
    
    if (card) {
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    }
    
    if (passwordInput) {
      passwordInput.focus();
      passwordInput.select();
    }
  }

  function showSuccess(msg) {
    if (successBox) {
      successBox.textContent = msg;
      successBox.style.display = 'flex';
    }
    if (errBox) errBox.style.display = 'none';
    if (passwordInput) passwordInput.classList.remove('input-error');
    if (usernameInput) usernameInput.classList.remove('input-error');
    
    if (usernameInput) usernameInput.disabled = true;
    if (passwordInput) passwordInput.disabled = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.className = 'btn-submit btn-success';
      submitBtn.innerHTML = '<span>✓ Signed In!</span>';
    }
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errBox) errBox.style.display = 'none';
      if (successBox) successBox.style.display = 'none';
      if (passwordInput) passwordInput.classList.remove('input-error');
      if (usernameInput) usernameInput.classList.remove('input-error');

      const username = usernameInput ? usernameInput.value.trim() : '';
      const password = passwordInput ? passwordInput.value : '';

      if (!username || !password) {
        showError('Please enter both your username and password.');
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner"></div><span>Signing In...</span>';
      }

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        let data = {};
        try {
          data = await res.json();
        } catch {
          data = { error: 'Invalid response received from server' };
        }

        if (!res.ok) {
          throw new Error(data.error || 'Invalid username or password');
        }

        showSuccess('Sign in successful! Redirecting to dashboard...');
        if (data.authHeader) {
          localStorage.setItem('collectrr_auth', data.authHeader);
        }

        const params = new URLSearchParams(window.location.search);
        const redirectUrl = params.get('redirect') || '/dashboard.html';

        setTimeout(() => {
          window.location.href = redirectUrl;
        }, 800);

      } catch (err) {
        showError(err.message || 'Authentication failed. Please check your credentials.');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.className = 'btn-submit';
          submitBtn.innerHTML = '<span>Sign In</span>';
        }
      }
    });
  }
});
