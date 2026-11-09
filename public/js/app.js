/**
 * ShareDrop Main Application Orchestrator
 * Wires SignalingClient, TransferManager, UIController, Modals, Drag-and-Drop,
 * Clipboard Paste, PWA Service Worker & Web Share Target.
 */

import { SignalingClient } from './network.js';
import { TransferManager } from './webrtc.js';
import { UIController, soundFx, formatBytes } from './ui.js';

class ShareDropApp {
  constructor() {
    this.signaling = new SignalingClient();
    this.transfers = new TransferManager(this.signaling);
    this.ui = new UIController();

    this.targetPeerForSend = null;
    this.incomingOfferPending = null;
  }

  async init() {
    this.ui.init();
    this._bindSignalingEvents();
    this._bindTransferEvents();
    this._bindUIEvents();
    this._bindDragAndDrop();
    this._bindClipboardPaste();
    this._registerServiceWorker();

    // Start signaling connection
    this.signaling.connect();

    // Check URL parameters for immediate room join
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      this.ui.setRoomBadge(roomParam.toUpperCase());
    }
  }

  /* ------------------------------------------------------------- */
  /* Signaling Event Handlers                                      */
  /* ------------------------------------------------------------- */
  _bindSignalingEvents() {
    this.signaling.on('connected', () => {
      this.ui.showToast('Connected to ShareDrop signaling', 'success', 2000);
    });

    this.signaling.on('disconnected', () => {
      this.ui.showToast('Signaling disconnected, reconnecting...', 'info', 2500);
    });

    this.signaling.on('welcome', (msg) => {
      if (msg.peer) {
        this.ui.setSelfPeer(msg.peer);
      }
      this.ui.renderPeers(Array.from(this.signaling.peers.values()), (peer) => this._onPeerSelected(peer));
    });

    this.signaling.on('self-updated', (peer) => {
      this.ui.setSelfPeer(peer);
    });

    this.signaling.on('peers', (peers) => {
      this.ui.renderPeers(peers, (peer) => this._onPeerSelected(peer));
      this._updateBeamTargetSelect(peers);
    });

    this.signaling.on('pair-code-created', (msg) => {
      const codeBox = document.getElementById('self-pair-code');
      const qrWrap = document.getElementById('pair-qr-wrap');
      const qrImg = document.getElementById('pair-qr-img');

      if (codeBox) codeBox.textContent = msg.code || '------';
      if (qrWrap && qrImg && msg.code) {
        qrImg.src = `/api/qr?data=${encodeURIComponent(msg.code)}`;
        qrWrap.style.display = 'flex';
      }
    });

    this.signaling.on('pair-success', (msg) => {
      this.ui.showToast(`Paired successfully with ${msg.peer ? msg.peer.displayName : 'device'}!`, 'success');
      this.ui.closeModal('modal-pair');
      soundFx.playCompleteChime();
    });

    this.signaling.on('room-joined', (msg) => {
      this.ui.setRoomBadge(msg.roomCode);
      this.ui.showToast(`Joined room ${msg.roomCode}`, 'success');
      this.ui.closeModal('modal-room');

      // Update room modal QR
      const qrWrap = document.getElementById('room-qr-wrap');
      const qrImg = document.getElementById('room-qr-img');
      if (qrWrap && qrImg && msg.roomCode) {
        const roomUrl = `${window.location.origin}/?room=${msg.roomCode}`;
        qrImg.src = `/api/qr?data=${encodeURIComponent(roomUrl)}`;
        qrWrap.style.display = 'flex';
      }
    });

    this.signaling.on('room-left', () => {
      this.ui.setRoomBadge(null);
      this.ui.showToast('Left public room', 'info');
    });

    this.signaling.on('file-offer', (offer) => {
      soundFx.playIncomingChime();
      this.transfers.handleIncomingOffer(offer);
    });

    this.signaling.on('text-beam', (msg) => {
      soundFx.playIncomingChime();
      this._showIncomingTextBeam(msg);
    });

    this.signaling.on('drop-available', (msg) => {
      this.ui.showToast(`New Drop Available: ${msg.drop ? msg.drop.code : ''}`, 'info');
    });

    this.signaling.on('error', (err) => {
      this.ui.showToast(err.message || 'Error occurred', 'error');
    });
  }

  /* ------------------------------------------------------------- */
  /* Transfer Event Handlers                                       */
  /* ------------------------------------------------------------- */
  _bindTransferEvents() {
    this.transfers.on('incoming-offer', (offer) => {
      if (offer.autoAccept) {
        this.ui.showToast(`Auto-accepting transfer from paired peer: ${offer.sender ? offer.sender.displayName : 'Peer'}`, 'info');
        return;
      }

      this.incomingOfferPending = offer;
      const peerName = (offer.sender && offer.sender.displayName) || 'Peer';
      document.getElementById('incoming-offer-peer-text').textContent = `${peerName} wants to send files:`;
      document.getElementById('incoming-offer-files-count').textContent = String((offer.files && offer.files.length) || 1);
      document.getElementById('incoming-offer-total-size').textContent = formatBytes(offer.totalSize);
      document.getElementById('incoming-offer-mode').textContent = offer.mode || 'webrtc';

      this.ui.openModal('modal-incoming-offer');
    });

    this.transfers.on('transfer-started', () => {
      this.ui.renderTransfers(this.transfers.getAllTransfers(), (id) => this.transfers.cancelTransfer(id));
      this.ui.showToast('Transfer started', 'info');
    });

    this.transfers.on('transfer-progress', () => {
      this.ui.renderTransfers(this.transfers.getAllTransfers(), (id) => this.transfers.cancelTransfer(id));
    });

    this.transfers.on('transfer-completed', () => {
      soundFx.playCompleteChime();
      this.ui.renderTransfers(this.transfers.getAllTransfers(), (id) => this.transfers.cancelTransfer(id));
      this.ui.showToast('Transfer completed successfully!', 'success');
    });

    this.transfers.on('transfer-declined', () => {
      this.ui.showToast('Transfer was declined by peer', 'error');
      this.ui.renderTransfers(this.transfers.getAllTransfers(), (id) => this.transfers.cancelTransfer(id));
    });

    this.transfers.on('transfer-cancelled', ({ reason }) => {
      this.ui.showToast(`Transfer cancelled (${reason || 'user'})`, 'info');
      this.ui.renderTransfers(this.transfers.getAllTransfers(), (id) => this.transfers.cancelTransfer(id));
    });

    this.transfers.on('transfer-failed', ({ error }) => {
      this.ui.showToast(`Transfer failed: ${error}`, 'error');
      this.ui.renderTransfers(this.transfers.getAllTransfers(), (id) => this.transfers.cancelTransfer(id));
    });
  }

  /* ------------------------------------------------------------- */
  /* UI Controls & Modal Actions                                   */
  /* ------------------------------------------------------------- */
  _bindUIEvents() {
    // Rename device
    const btnEditName = document.getElementById('btn-edit-display-name');
    const inputRename = document.getElementById('rename-input');
    const btnSaveRename = document.getElementById('btn-save-rename');

    btnEditName.addEventListener('click', () => {
      inputRename.value = this.signaling.displayName || '';
      this.ui.openModal('modal-rename');
      inputRename.focus();
    });

    btnSaveRename.addEventListener('click', () => {
      const name = inputRename.value.trim();
      if (name) {
        this.signaling.updateDisplayName(name);
        this.ui.closeModal('modal-rename');
        this.ui.showToast(`Device name updated to "${name}"`, 'success');
      }
    });

    // Leave room
    document.getElementById('btn-leave-room').addEventListener('click', () => {
      this.signaling.leaveRoom();
    });

    // Pair Code Dock & Actions
    document.getElementById('dock-btn-pair').addEventListener('click', () => {
      this.signaling.createPairCode();
      this.ui.openModal('modal-pair');
    });

    document.getElementById('btn-join-pair-code').addEventListener('click', () => {
      const input = document.getElementById('input-pair-code');
      const code = (input.value || '').trim();
      if (code.length === 6) {
        this.signaling.joinPairCode(code);
      } else {
        this.ui.showToast('Enter a valid 6-digit pair code', 'error');
      }
    });

    // Public Room Dock & Actions
    document.getElementById('dock-btn-room').addEventListener('click', () => {
      this.ui.openModal('modal-room');
    });

    document.getElementById('btn-submit-join-room').addEventListener('click', () => {
      const input = document.getElementById('input-room-code');
      const code = (input.value || '').trim().toUpperCase();
      if (code) {
        this.signaling.joinRoom(code);
      }
    });

    document.getElementById('btn-create-fresh-room').addEventListener('click', () => {
      this.signaling.createRoom();
    });

    // Beam Text Dock & Actions
    document.getElementById('dock-btn-text').addEventListener('click', () => {
      this.ui.openModal('modal-text-beam');
    });

    document.getElementById('btn-send-beam-text').addEventListener('click', () => {
      const targetSelect = document.getElementById('beam-target-select');
      const textInput = document.getElementById('beam-text-content');
      const targetId = targetSelect.value;
      const text = textInput.value.trim();

      if (!targetId) {
        this.ui.showToast('Please select a target peer', 'error');
        return;
      }
      if (!text) {
        this.ui.showToast('Please enter text to beam', 'error');
        return;
      }

      this.signaling.sendTextBeam(targetId, text);
      this.ui.closeModal('modal-text-beam');
      textInput.value = '';
      this.ui.showToast('Text message beamed!', 'success');
    });

    // CLI / Cloud Drop Dock & Actions
    document.getElementById('dock-btn-drop').addEventListener('click', () => {
      this.ui.openModal('modal-drop');
    });

    document.getElementById('btn-fetch-drop').addEventListener('click', async () => {
      const input = document.getElementById('input-drop-code');
      const code = (input.value || '').trim().toUpperCase();
      if (!code) return;
      window.location.href = `/d/${code}`;
    });

    document.getElementById('btn-upload-cli-drop').addEventListener('click', async () => {
      const fileInput = document.getElementById('cli-drop-file-input');
      const resultBox = document.getElementById('drop-result-box');
      if (!fileInput.files || fileInput.files.length === 0) {
        this.ui.showToast('Select at least one file to upload', 'error');
        return;
      }

      const formData = new FormData();
      for (const f of fileInput.files) {
        formData.append('files', f);
      }

      resultBox.style.display = 'block';
      resultBox.textContent = 'Uploading files to ephemeral drop...';

      try {
        const resp = await fetch('/api/drop', {
          method: 'POST',
          body: formData
        });
        const json = await resp.json();
        if (json.success && json.data) {
          resultBox.innerHTML = `
            <b>Drop Created!</b><br>
            Code: <span style="color: var(--accent-terracotta); font-size: 1.1rem; font-weight: bold;">${json.data.code}</span><br>
            Download URL: <a href="${json.data.downloadUrl}" target="_blank" style="text-decoration: underline;">${json.data.downloadUrl}</a><br>
            CLI Command:<br>
            <code>sharedrop receive ${json.data.code}</code>
          `;
          this.ui.showToast(`Drop created: ${json.data.code}`, 'success');
        } else {
          resultBox.textContent = `Upload failed: ${json.error ? json.error.message : 'Unknown error'}`;
        }
      } catch (err) {
        resultBox.textContent = `Upload error: ${err.message}`;
      }
    });

    // Incoming file offer accept/decline
    document.getElementById('btn-accept-offer').addEventListener('click', () => {
      if (this.incomingOfferPending) {
        this.transfers.respondToOffer(this.incomingOfferPending.transferId, true);
        this.ui.closeModal('modal-incoming-offer');
        this.incomingOfferPending = null;
      }
    });

    document.getElementById('btn-decline-offer').addEventListener('click', () => {
      if (this.incomingOfferPending) {
        this.transfers.respondToOffer(this.incomingOfferPending.transferId, false);
        this.ui.closeModal('modal-incoming-offer');
        this.incomingOfferPending = null;
      }
    });

    // Settings Modal
    document.getElementById('btn-open-settings').addEventListener('click', () => {
      const autoAcceptCheckbox = document.getElementById('setting-auto-accept');
      autoAcceptCheckbox.checked = this.signaling.autoAcceptPaired;
      this.ui.openModal('modal-settings');
    });

    document.getElementById('setting-auto-accept').addEventListener('change', (e) => {
      this.signaling.setAutoAcceptPaired(e.target.checked);
      this.ui.showToast(`Auto-accept paired devices ${e.target.checked ? 'enabled' : 'disabled'}`, 'info');
    });

    document.getElementById('btn-clear-pair-secrets').addEventListener('click', () => {
      if (confirm('Forget all paired device keys?')) {
        this.signaling.clearPairSecrets();
        this.ui.closeModal('modal-settings');
        this.ui.showToast('All saved device pairings cleared', 'info');
      }
    });

    // Legal & Documentation In-App Modal Viewer
    document.querySelectorAll('.doc-link').forEach((link) => {
      link.addEventListener('click', async (e) => {
        e.preventDefault();
        const docType = link.getAttribute('data-doc');
        const href = link.getAttribute('href');
        const titleMap = {
          terms: 'Terms of Service',
          privacy: 'Privacy Policy',
          security: 'Security Architecture & Whitepaper',
          faq: 'Frequently Asked Questions',
        };

        const modalTitle = document.getElementById('doc-viewer-title');
        const contentBox = document.getElementById('doc-viewer-content');
        const externalBtn = document.getElementById('doc-viewer-external');

        if (modalTitle) modalTitle.textContent = titleMap[docType] || 'Documentation';
        if (externalBtn) externalBtn.href = href;
        if (contentBox) contentBox.innerHTML = '<div class="doc-viewer-loading">Loading document...</div>';

        this.ui.openModal('modal-doc-viewer');

        try {
          const res = await fetch(href);
          const html = await res.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, 'text/html');
          const container = doc.querySelector('.legal-page-container');
          if (container && contentBox) {
            const navHeader = container.querySelector('.legal-nav-header');
            if (navHeader) navHeader.remove();
            const footer = container.querySelector('.legal-footer');
            if (footer) footer.remove();
            contentBox.innerHTML = container.innerHTML;
          } else if (contentBox) {
            contentBox.innerHTML = `<iframe src="${href}" style="width:100%; height:70vh; border:none;"></iframe>`;
          }
        } catch {
          if (contentBox) {
            contentBox.innerHTML = `<p>Failed to load document inline. <a href="${href}" target="_blank" style="color:var(--accent-terracotta);">Click here to open directly</a>.</p>`;
          }
        }
      });
    });

    // Hidden File Pickers
    const filePicker = document.getElementById('file-picker-input');
    const folderPicker = document.getElementById('folder-picker-input');

    filePicker.addEventListener('change', () => {
      if (filePicker.files && filePicker.files.length > 0 && this.targetPeerForSend) {
        this.transfers.sendFiles(this.targetPeerForSend.id, filePicker.files);
        filePicker.value = '';
      }
    });

    folderPicker.addEventListener('change', () => {
      if (folderPicker.files && folderPicker.files.length > 0 && this.targetPeerForSend) {
        this.transfers.sendFiles(this.targetPeerForSend.id, folderPicker.files);
        folderPicker.value = '';
      }
    });

    // Peer Action Menu Modal
    document.getElementById('btn-action-send-files').addEventListener('click', () => {
      this.ui.closeModal('modal-peer-actions');
      filePicker.click();
    });

    document.getElementById('btn-action-send-folder').addEventListener('click', () => {
      this.ui.closeModal('modal-peer-actions');
      folderPicker.click();
    });

    document.getElementById('btn-action-send-text').addEventListener('click', () => {
      this.ui.closeModal('modal-peer-actions');
      if (this.targetPeerForSend) {
        const select = document.getElementById('beam-target-select');
        select.value = this.targetPeerForSend.id;
        this.ui.openModal('modal-text-beam');
      }
    });
  }

  _onPeerSelected(peer) {
    this.targetPeerForSend = peer;
    document.getElementById('peer-action-title').textContent = `Send to ${peer.displayName || 'Peer'}`;
    this.ui.openModal('modal-peer-actions');
  }

  _updateBeamTargetSelect(peers) {
    const select = document.getElementById('beam-target-select');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Choose Peer --</option>';

    peers.forEach((p) => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.displayName || 'Peer'} (${p.sharedVia || 'lan'})`;
      select.appendChild(opt);
    });

    if (currentVal) {
      select.value = currentVal;
    }
  }

  _showIncomingTextBeam(msg) {
    const peerName = (msg.sender && msg.sender.displayName) || 'Peer';
    const text = msg.text || '';

    // Check if text is URL
    const isUrl = /^https?:\/\/[^\s]+$/i.test(text.trim());

    if (isUrl) {
      if (confirm(`Incoming link from ${peerName}:\n\n${text}\n\nOpen link in new tab?`)) {
        window.open(text.trim(), '_blank', 'noopener,noreferrer');
      }
    } else {
      navigator.clipboard.writeText(text).then(() => {
        this.ui.showToast(`Copied text beam from ${peerName} to clipboard!`, 'success');
      }).catch(() => {
        prompt(`Text beam from ${peerName}:`, text);
      });
    }
  }

  /* ------------------------------------------------------------- */
  /* Drag and Drop Files/Folders                                   */
  /* ------------------------------------------------------------- */
  _bindDragAndDrop() {
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('dragover-active');
    });

    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || e.relatedTarget === document.documentElement) {
        document.body.classList.remove('dragover-active');
      }
    });

    window.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dragover-active');

      const dt = e.dataTransfer;
      if (!dt || !dt.files || dt.files.length === 0) return;

      const peerList = Array.from(this.signaling.peers.values());
      if (peerList.length === 0) {
        this.ui.showToast('No active peers connected on your radar to receive files', 'error');
        return;
      }

      // If only 1 peer, auto-send to that peer, otherwise prompt
      const targetPeer = peerList.length === 1 ? peerList[0] : (this.targetPeerForSend || peerList[0]);
      this.transfers.sendFiles(targetPeer.id, dt.files);
    });
  }

  /* ------------------------------------------------------------- */
  /* Clipboard Image/Text Paste (Ctrl+V / Cmd+V)                   */
  /* ------------------------------------------------------------- */
  _bindClipboardPaste() {
    window.addEventListener('paste', (e) => {
      // Ignore if user is currently typing in an input or textarea
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        return;
      }

      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      if (!items) return;

      const files = [];
      let textContent = '';

      for (const item of items) {
        if (item.kind === 'file') {
          const blob = item.getAsFile();
          if (blob) {
            const ext = blob.type.split('/')[1] || 'bin';
            const namedFile = new File([blob], `clipboard-${Date.now()}.${ext}`, { type: blob.type });
            files.push(namedFile);
          }
        } else if (item.kind === 'string' && item.type === 'text/plain') {
          item.getAsString((str) => {
            textContent = str;
          });
        }
      }

      const peerList = Array.from(this.signaling.peers.values());
      if (peerList.length === 0) {
        this.ui.showToast('No active peers to send pasted clipboard data to', 'error');
        return;
      }

      const target = this.targetPeerForSend || peerList[0];

      if (files.length > 0) {
        this.transfers.sendFiles(target.id, files);
        this.ui.showToast(`Pasted image beamed to ${target.displayName || 'peer'}!`, 'info');
      } else if (textContent) {
        this.signaling.sendTextBeam(target.id, textContent);
        this.ui.showToast(`Pasted text beamed to ${target.displayName || 'peer'}!`, 'info');
      }
    });
  }

  /* ------------------------------------------------------------- */
  /* Service Worker & Web Share Target                             */
  /* ------------------------------------------------------------- */
  _registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        // Listen for messages from sw.js (Web Share Target payload)
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'pwa-share-target') {
            const { files, text, url } = event.data;
            const peerList = Array.from(this.signaling.peers.values());
            if (peerList.length > 0) {
              const target = peerList[0];
              if (files && files.length > 0) {
                this.transfers.sendFiles(target.id, files);
              } else if (text || url) {
                this.signaling.sendTextBeam(target.id, text || url);
              }
            }
          }
        });

        // Request any pending shared payload
        if (navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'consume-share-target' });
        }
      }).catch((err) => {
        console.warn('[ShareDrop] Service Worker registration failed:', err);
      });
    }
  }
}

// Bootstrap application on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  const app = new ShareDropApp();
  app.init();
});
