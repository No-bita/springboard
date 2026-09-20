document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('resetForm');
  const card = document.querySelector('.card');
  const errBox = document.getElementById('errorAlert');
  const successBox = document.getElementById('successAlert');
  const submitBtn = document.getElementById('submitBtn');
  const usernameInput = document.getElementById('username');
  const newPasswordInput = document.getElementById('newPassword');
  const confirmPasswordInput = document.getElementById('confirmPassword');

  function initToggle(inputId) {
    const btn = document.querySelector(`[data-target="${inputId}"]`);
    const input = document.getElementById(inputId);
    if (!btn || !input) return;

    const toggle = (e) => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      const currentType = input.getAttribute('type') || 'password';
      const nextType = currentType === 'password' ? 'text' : 'password';
      input.setAttribute('type', nextType);
      btn.textContent = nextType === 'password' ? 'Show' : 'Hide';
    };

    btn.addEventListener('click', toggle);
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
  }

  initToggle('newPassword');
  initToggle('confirmPassword');

  function showError(msg) {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.style.display = 'block';
    if (successBox) successBox.style.display = 'none';
    if (card) {
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    }
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errBox) errBox.style.display = 'none';
      if (successBox) successBox.style.display = 'none';

      const username = usernameInput ? usernameInput.value.trim() : '';
      const newPassword = newPasswordInput ? newPasswordInput.value : '';
      const confirmPassword = confirmPasswordInput ? confirmPasswordInput.value : '';

      if (!username) {
        showError('Please enter your username.');
        if (usernameInput) usernameInput.focus();
        return;
      }

      if (!newPassword || newPassword.length < 6) {
        showError('Password must be at least 6 characters.');
        if (newPasswordInput) newPasswordInput.focus();
        return;
      }

      if (newPassword !== confirmPassword) {
        showError('Passwords do not match.');
        if (confirmPasswordInput) confirmPasswordInput.focus();
        return;
      }

      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Updating password...';
      }

      try {
        const res = await fetch('/api/auth/reset-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, newPassword })
        });

        let data = {};
        try {
          data = await res.json();
        } catch {
          data = { error: 'Invalid response from server' };
        }

        if (!res.ok) {
          throw new Error(data.error || 'Failed to reset password');
        }

        if (usernameInput) usernameInput.disabled = true;
        if (newPasswordInput) newPasswordInput.disabled = true;
        if (confirmPasswordInput) confirmPasswordInput.disabled = true;

        if (submitBtn) {
          submitBtn.className = 'btn-submit btn-success';
          submitBtn.textContent = '✓ Password Updated!';
        }
        if (successBox) {
          successBox.textContent = 'Password updated successfully! Redirecting to sign in...';
          successBox.style.display = 'block';
        }

        setTimeout(() => {
          window.location.href = '/login.html';
        }, 1200);
      } catch (err) {
        showError(err.message || 'An unexpected error occurred.');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Update Password';
        }
      }
    });
  }
});
