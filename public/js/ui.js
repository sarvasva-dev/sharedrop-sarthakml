/**
 * ShareDrop UI Renderer & DOM Controller
 * Warm Editorial theme, concentric animated radar, peer node layout, modals,
 * Web Audio synth chimes, and notifications.
 */

// Format bytes into human readable string
export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatSpeed(bytesPerSec) {
  return `${formatBytes(bytesPerSec)}/s`;
}

/* ==========================================================================
   Web Audio Synthesizer Chimes
   ========================================================================== */
class AudioEffects {
  constructor() {
    this.ctx = null;
  }

  _init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  playIncomingChime() {
    try {
      this._init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.2, now + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(now);
      osc.stop(now + 0.35);
    } catch {
      // Audio autoplay policy fallback
    }
  }

  playCompleteChime() {
    try {
      this._init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;

      // Chord chime: F#5 -> A5 -> C#6
      const freqs = [739.99, 880, 1108.73];
      freqs.forEach((freq, idx) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();

        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + idx * 0.07);

        gain.gain.setValueAtTime(0, now + idx * 0.07);
        gain.gain.linearRampToValueAtTime(0.15, now + idx * 0.07 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.35);

        osc.connect(gain);
        gain.connect(this.ctx.destination);

        osc.start(now + idx * 0.07);
        osc.stop(now + idx * 0.07 + 0.35);
      });
    } catch {
      // Audio fallback
    }
  }
}

export const soundFx = new AudioEffects();

/* ==========================================================================
   UI Controller Class
   ========================================================================== */
export class UIController {
  constructor() {
    this.peersContainer = document.getElementById('peers-stage');
    this.radarEmptyHint = document.getElementById('radar-empty-hint');
    this.selfDisplayName = document.getElementById('self-display-name');
    this.selfNetworkMeta = document.getElementById('self-network-meta');
    this.activeRoomBadge = document.getElementById('active-room-badge');
    this.activeRoomLabel = document.getElementById('active-room-label');
    this.transfersContainer = document.getElementById('transfers-container');
    this.transfersDockBadge = document.getElementById('transfers-dock-badge');
    this.toastContainer = document.getElementById('toast-container');

    this.theme = localStorage.getItem('sharedrop_theme') || 'light';
    this._applyTheme(this.theme);

    this.selectedPeerId = null;
    this.boundModalHandlers = false;
  }

  init() {
    this._setupGlobalModalTriggers();
    this._setupThemeToggle();
  }

  _setupThemeToggle() {
    const btn = document.getElementById('btn-theme-toggle');
    const sunIcon = document.getElementById('theme-icon-sun');
    const moonIcon = document.getElementById('theme-icon-moon');

    const updateIcons = (theme) => {
      if (theme === 'dark') {
        sunIcon.style.display = 'none';
        moonIcon.style.display = 'block';
      } else {
        sunIcon.style.display = 'block';
        moonIcon.style.display = 'none';
      }
    };

    updateIcons(this.theme);

    btn.addEventListener('click', () => {
      this.theme = this.theme === 'light' ? 'dark' : 'light';
      this._applyTheme(this.theme);
      updateIcons(this.theme);
    });
  }

  _applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', '#121214');
    } else {
      document.documentElement.removeAttribute('data-theme');
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', '#FAF8F5');
    }
    localStorage.setItem('sharedrop_theme', theme);
  }

  _setupGlobalModalTriggers() {
    if (this.boundModalHandlers) return;
    this.boundModalHandlers = true;

    // Data-close buttons
    document.querySelectorAll('[data-close]').forEach((el) => {
      el.addEventListener('click', () => {
        const modalId = el.getAttribute('data-close');
        this.closeModal(modalId);
      });
    });

    // Close on backdrop click
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) {
          backdrop.classList.remove('active');
        }
      });
    });

    // Transfer drawer toggle
    const btnDrawer = document.getElementById('dock-btn-transfers');
    const drawerBackdrop = document.getElementById('transfer-drawer-backdrop');
    const btnCloseDrawer = document.getElementById('btn-close-drawer');

    btnDrawer.addEventListener('click', () => {
      drawerBackdrop.classList.add('active');
    });

    btnCloseDrawer.addEventListener('click', () => {
      drawerBackdrop.classList.remove('active');
    });

    drawerBackdrop.addEventListener('click', (e) => {
      if (e.target === drawerBackdrop) {
        drawerBackdrop.classList.remove('active');
      }
    });
  }

  openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('active');
  }

  closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.remove('active');
  }

  showToast(message, type = 'info', duration = 3500) {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    this.toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-10px)';
      toast.style.transition = 'all 200ms ease';
      setTimeout(() => toast.remove(), 220);
    }, duration);
  }

  setSelfPeer(peer) {
    if (!peer) return;
    this.selfDisplayName.textContent = peer.displayName || 'You';
    this.selfNetworkMeta.textContent = peer.ip ? `IP: ${peer.ip}` : 'Local Peer';
  }

  setRoomBadge(roomCode) {
    if (roomCode) {
      this.activeRoomBadge.style.display = 'inline-flex';
      this.activeRoomLabel.textContent = `ROOM: ${roomCode}`;
    } else {
      this.activeRoomBadge.style.display = 'none';
    }
  }

  /**
   * Render peers on concentric radar orbits
   * @param {Array<any>} peers
   * @param {Function} onPeerClick
   */
  renderPeers(peers, onPeerClick) {
    this.peersContainer.innerHTML = '';
    const validPeers = (peers || []).filter((p) => p && p.id);

    if (validPeers.length === 0) {
      this.radarEmptyHint.style.display = 'block';
      return;
    }

    this.radarEmptyHint.style.display = 'none';

    // Distribute peers evenly on an orbit circle
    const count = validPeers.length;
    // Calculate radius based on container size: 130px to 210px
    const stageWidth = this.peersContainer.clientWidth || 600;
    const stageHeight = this.peersContainer.clientHeight || 500;
    const minDim = Math.min(stageWidth, stageHeight);
    const radius = Math.min(minDim * 0.35, 190);

    const centerX = stageWidth / 2;
    const centerY = stageHeight / 2;

    validPeers.forEach((peer, i) => {
      const angle = (2 * Math.PI / count) * i - Math.PI / 2;
      const x = centerX + radius * Math.cos(angle);
      const y = centerY + radius * Math.sin(angle);

      const node = document.createElement('div');
      node.className = `peer-node ${peer.sharedVia === 'paired' ? 'paired' : ''}`;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      node.title = `${peer.displayName || 'Peer'} (${peer.sharedVia || 'lan'})`;

      const deviceType = (peer.device && peer.device.type) || 'desktop';
      let iconSvg = '';
      if (deviceType === 'mobile' || deviceType === 'tablet') {
        iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>`;
      } else {
        iconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>`;
      }

      let badgeHtml = '';
      if (peer.sharedVia === 'paired') {
        badgeHtml = `<span class="peer-badge-pill">PAIRED</span>`;
      } else if (peer.sharedVia === 'room') {
        badgeHtml = `<span class="peer-badge-pill" style="background: var(--accent-terracotta);">ROOM</span>`;
      }

      node.innerHTML = `
        <div class="peer-avatar">
          ${iconSvg}
          ${badgeHtml}
        </div>
        <div class="peer-label">
          <span class="peer-name">${peer.displayName || 'Peer'}</span>
          <span class="peer-subtext">${peer.device && peer.device.os ? peer.device.os : 'Ready'}</span>
        </div>
      `;

      node.addEventListener('click', () => {
        if (typeof onPeerClick === 'function') {
          onPeerClick(peer);
        }
      });

      this.peersContainer.appendChild(node);
    });
  }

  /**
   * Render transfer queue & progress cards in drawer
   */
  renderTransfers(transfersList, onCancel) {
    if (!transfersList || transfersList.length === 0) {
      this.transfersContainer.innerHTML = `<p style="color: var(--ink-tertiary); font-size: 0.85rem; text-align: center; margin-top: 40px;">No transfers yet</p>`;
      this.transfersDockBadge.style.display = 'none';
      return;
    }

    const activeCount = transfersList.filter((t) => t.status === 'transferring' || t.status === 'pending').length;
    if (activeCount > 0) {
      this.transfersDockBadge.style.display = 'inline-flex';
      this.transfersDockBadge.textContent = String(activeCount);
    } else {
      this.transfersDockBadge.style.display = 'none';
    }

    this.transfersContainer.innerHTML = '';
    // Show newest first
    [...transfersList].reverse().forEach((tx) => {
      const card = document.createElement('div');
      card.className = 'transfer-card';

      const fileName = (tx.files && tx.files[0] && tx.files[0].name)
        ? (tx.files.length > 1 ? `${tx.files[0].name} (+${tx.files.length - 1} more)` : tx.files[0].name)
        : (tx.filesMeta && tx.filesMeta[0] ? tx.filesMeta[0].name : 'File Transfer');

      const percent = tx.totalSize > 0
        ? Math.min(100, Math.round((tx.bytesTransferred / tx.totalSize) * 100))
        : (tx.status === 'completed' ? 100 : 0);

      const statusBadge = `<span class="transfer-card-badge ${tx.status}">${tx.status}</span>`;

      card.innerHTML = `
        <div class="transfer-card-top">
          <span class="transfer-card-title">${fileName}</span>
          ${statusBadge}
        </div>
        <div class="progress-bar-wrap">
          <div class="progress-bar-fill" style="width: ${percent}%;"></div>
        </div>
        <div class="transfer-card-meta">
          <span>${formatBytes(tx.bytesTransferred)} / ${formatBytes(tx.totalSize)} (${percent}%)</span>
          <span>${tx.speed ? formatSpeed(tx.speed) : (tx.mode || 'webrtc')}</span>
        </div>
      `;

      if (tx.status === 'transferring' || tx.status === 'pending') {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn-secondary';
        cancelBtn.style.minHeight = '32px';
        cancelBtn.style.padding = '2px 8px';
        cancelBtn.style.fontSize = '0.75rem';
        cancelBtn.style.marginTop = '4px';
        cancelBtn.style.alignSelf = 'flex-end';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => {
          if (onCancel) onCancel(tx.id);
        });
        card.appendChild(cancelBtn);
      }

      this.transfersContainer.appendChild(card);
    });
  }
}
