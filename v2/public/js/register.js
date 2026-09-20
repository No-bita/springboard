document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('registerForm');
  const card = document.querySelector('.login-card');
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
    errBox.style.display = 'block';
    errBox.hidden = false;
    if (successBox) {
      successBox.style.display = 'none';
      successBox.hidden = true;
    }
    if (card) {
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    }
    if (passwordInput) {
      passwordInput.focus();
    }
  }

  function showSuccess(msg) {
    if (successBox) {
      successBox.textContent = msg;
      successBox.style.display = 'block';
      successBox.hidden = false;
    }
    if (errBox) {
      errBox.style.display = 'none';
      errBox.hidden = true;
    }
    if (usernameInput) usernameInput.disabled = true;
    if (passwordInput) passwordInput.disabled = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.className = 'btn-submit btn-success';
      submitBtn.textContent = '✓ Account Created!';
    }
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errBox) {
        errBox.style.display = 'none';
        errBox.hidden = true;
      }
      if (successBox) {
        successBox.style.display = 'none';
        successBox.hidden = true;
      }

      const username = usernameInput ? usernameInput.value.trim() : '';
      const password = passwordInput ? passwordInput.value : '';

      if (!username || !password || password.length < 6) {
        showError('Username and password (min 6 characters) are required.');
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Registering...';
      }

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });

        let data = {};
        try {
          data = await res.json();
        } catch {
          data = { error: 'Invalid response from server' };
        }

        if (!res.ok) throw new Error(data.error || 'Registration failed');

        showSuccess('Registration successful! Directing to dashboard...');

        if (data.authHeader) {
          localStorage.setItem('collectrr_auth', data.authHeader);
        }

        setTimeout(() => {
          window.location.href = '/dashboard.html';
        }, 1000);
      } catch (err) {
        showError(err.message || 'Registration failed');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Register';
        }
      }
    });
  }
});
