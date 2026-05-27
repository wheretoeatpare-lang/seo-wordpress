const API_SECRET_CLIENT = window.__CFG__.secret;
let polling = null;
let wasRunning = false;
let scanMode = 'all';
let globalKeywords = [];

// { [id]: { seo: 'approved'|'skipped'|null, alt: 'approved'|'skipped'|null } }
let approvalDecisions = {};

// Whether the approval panel has already been drawn for this batch
let panelRendered = false;

// FIX: Guard flag — true while /api/approve request is in-flight.
// Prevents a stale status poll from re-drawing the approval panel mid-commit.
let isSubmitting = false;

// ── Scan mode ─────────────────────────────────────────────────────────────────
function setScanMode(mode) {
  scanMode = mode;
  document.getElementById('mode-all').classList.toggle('active', mode === 'all');
  document.getElementById('mode-specific').classList.toggle('active', mode === 'specific');
  document.getElementById('pages-field').style.display = mode === 'specific' ? 'block' : 'none';
}

// ── Keyword tags ──────────────────────────────────────────────────────────────
function handleKwInput(e) {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  var val = e.target.value.trim();
  if (!val || globalKeywords.includes(val)) { e.target.value = ''; return; }
  globalKeywords.push(val);
  e.target.value = '';
  renderKwTags();
}

function removeKw(kw) {
  globalKeywords = globalKeywords.filter(function(k) { return k !== kw; });
  renderKwTags();
}

function renderKwTags() {
  var el = document.getElementById('kw-tags');
  el.innerHTML = '';
  globalKeywords.forEach(function(kw) {
    var tag = document.createElement('span');
    tag.className = 'kw-tag';
    tag.textContent = kw;
    var x = document.createElement('span');
    x.className = 'kw-tag-remove';
    x.textContent = '×';
    x.onclick = function() { removeKw(kw); };
    tag.appendChild(x);
    el.appendChild(tag);
  });
}

// ── Trigger scan ──────────────────────────────────────────────────────────────
async function triggerScan() {
  try {
    var targetPages = scanMode === 'specific'
      ? (document.getElementById('target-pages').value || '').split('\n').map(function(s) { return s.trim(); }).filter(Boolean)
      : [];

    var res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      body: JSON.stringify({ targetPages: targetPages, globalKeywords: globalKeywords })
    });
    var data = await res.json();
    console.log('Scan triggered:', data);

    // Reset approval state for fresh scan
    approvalDecisions = {};
    panelRendered = false;
    window.__PENDING__ = [];
    document.getElementById('approval-items').innerHTML = '';
    document.getElementById('approval-panel').classList.remove('visible');

    startPolling();
  } catch(e) { console.error('Failed to trigger scan', e); }
}

// ── Polling ───────────────────────────────────────────────────────────────────
function startPolling() {
  if (polling) clearInterval(polling);
  polling = setInterval(fetchStatus, 1500);
  fetchStatus();
}

async function fetchStatus() {
  try {
    var results = await Promise.all([fetch('/api/status'), fetch('/api/logs')]);
    var status = await results[0].json();
    var logsData = await results[1].json();
    updateUI(status, logsData);
  } catch(e) {}
}

// ── Approval panel ────────────────────────────────────────────────────────────
// Only renders once per batch — never wipes DOM while user is deciding
function maybeRenderApprovalPanel(pending) {
  var panel = document.getElementById('approval-panel');

  // FIX: Never touch the panel while a commit request is in-flight —
  // the server may still briefly report stale pendingApprovals.
  if (isSubmitting) return;

  if (!pending || pending.length === 0) {
    panel.classList.remove('visible');
    panelRendered = false;
    return;
  }

  panel.classList.add('visible');

  // CRITICAL: skip re-render if panel is already drawn — user may be mid-decision
  if (panelRendered) {
    refreshCommitBar();
    return;
  }

  panelRendered = true;
  var itemsEl = document.getElementById('approval-items');
  itemsEl.innerHTML = '';

  pending.forEach(function(p) {
    var reasonParts = [];
    if (!p.titleOk) reasonParts.push('TITLE: ' + (p.basisTitle || p.reasonTitle || ''));
    if (!p.metaOk)  reasonParts.push('META: '  + (p.basisMeta  || p.reasonMeta  || ''));
    var reasonText = reasonParts.join('\n');

    var div = document.createElement('div');
    div.className = 'approval-item';
    div.id = 'item-' + p.id;

    // Determine which sections exist for this item
    var hasSeo = !p.titleOk || !p.metaOk;
    var hasAlt = p.imageFixes && p.imageFixes.length > 0;

    // Init decision slots
    if (!approvalDecisions[p.id]) {
      approvalDecisions[p.id] = {
        seo: hasSeo ? null : 'skip-na',
        alt: hasAlt ? null : 'skip-na'
      };
    }

    var html = '<div class="approval-file">📄 ' + escapeHtml(p.filePath) +
      ' · <a href="' + escapeHtml(p.url) + '" target="_blank" style="color:var(--muted);font-size:11px">' +
      escapeHtml(p.url) + '</a></div>';

    // ── SEO Meta section ──────────────────────────────────────────────────────
    if (hasSeo) {
      html += '<div class="section-block" id="seo-block-' + p.id + '">' +
        '<div class="section-block-header">' +
          '<span class="section-block-label">📝 SEO Meta</span>' +
          '<div class="section-btns">' +
            '<button class="btn-section-approve" id="btn-seo-approve-' + p.id + '" onclick="decideSection(\'' + p.id + '\',\'seo\',\'approved\')">✓ Apply</button>' +
            '<button class="btn-section-skip" id="btn-seo-skip-' + p.id + '" onclick="decideSection(\'' + p.id + '\',\'seo\',\'skipped\')">✗ Skip</button>' +
          '</div>' +
        '</div>' +
        '<div class="approval-row">' +
          '<div class="approval-label">Title</div>' +
          '<div class="approval-old">' + escapeHtml(p.oldTitle) + '</div>' +
          '<div class="approval-new">' + escapeHtml(p.newTitle) + '</div>' +
        '</div>' +
        '<div class="approval-row">' +
          '<div class="approval-label">Meta</div>' +
          '<div class="approval-old">' + escapeHtml(p.oldMeta) + '</div>' +
          '<div class="approval-new">' + escapeHtml(p.newMeta) + '</div>' +
        '</div>' +
        (reasonText ? '<div class="approval-reason">' + escapeHtml(reasonText) + '</div>' : '') +
      '</div>';
    }

    // ── Image Alt section ─────────────────────────────────────────────────────
    if (hasAlt) {
      html += '<div class="section-block" id="alt-block-' + p.id + '">' +
        '<div class="section-block-header">' +
          '<span class="section-block-label">🖼 Image Alt Text (' + p.imageFixes.length + ' fix' + (p.imageFixes.length > 1 ? 'es' : '') + ')</span>' +
          '<div class="section-btns">' +
            '<button class="btn-section-approve" id="btn-alt-approve-' + p.id + '" onclick="decideSection(\'' + p.id + '\',\'alt\',\'approved\')">✓ Apply</button>' +
            '<button class="btn-section-skip" id="btn-alt-skip-' + p.id + '" onclick="decideSection(\'' + p.id + '\',\'alt\',\'skipped\')">✗ Skip</button>' +
          '</div>' +
        '</div>' +
        p.imageFixes.map(function(f) {
          return '<div class="approval-image-row">' +
            '<div class="approval-image-src">' + escapeHtml(f.src.split('/').pop()) + '</div>' +
            '<div class="approval-old">' + escapeHtml(f.currentAlt || '(no alt text)') + '</div>' +
            '<div class="approval-new">' + escapeHtml(f.newAlt) + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    // Compression runs separately via dedicated button — not shown here

    div.innerHTML = html;
    itemsEl.appendChild(div);
  });

  refreshCommitBar();
}

// Called when user clicks section-level Approve or Skip
function decideSection(id, section, action) {
  if (!approvalDecisions[id]) approvalDecisions[id] = { seo: null, alt: null };
  approvalDecisions[id][section] = action;

  // Highlight the section block
  var block = document.getElementById(section + '-block-' + id);
  if (block) {
    block.className = 'section-block ' + (action === 'approved' ? 'section-approved' : 'section-skipped');
  }
  // Highlight buttons
  var btnA = document.getElementById('btn-' + section + '-approve-' + id);
  var btnS = document.getElementById('btn-' + section + '-skip-'    + id);
  if (btnA) btnA.className = 'btn-section-approve' + (action === 'approved' ? ' selected' : '');
  if (btnS) btnS.className = 'btn-section-skip'    + (action === 'skipped'  ? ' selected' : '');

  // Update card border based on overall decision
  var d = approvalDecisions[id];
  var anyApproved = d.seo === 'approved' || d.alt === 'approved';
  var allDecided  = (d.seo !== null) && (d.alt !== null);
  var item = document.getElementById('item-' + id);
  if (item && allDecided) {
    item.className = 'approval-item ' + (anyApproved ? 'approved' : 'skipped');
  }

  refreshCommitBar();
}

// Recalculate commit button state — checks all sections per page
function refreshCommitBar() {
  var btn  = document.getElementById('commit-btn');
  var hint = document.getElementById('commit-hint');
  if (!btn || !hint) return;

  var pending = window.__PENDING__ || [];
  if (pending.length === 0) return;

  var totalSections  = 0;  // how many non-N/A sections exist
  var decidedSections = 0;
  var anyApproved    = false;

  for (var i = 0; i < pending.length; i++) {
    var p = pending[i];
    var d = approvalDecisions[p.id] || {};
    var hasSeo = !p.titleOk || !p.metaOk;
    var hasAlt = p.imageFixes && p.imageFixes.length > 0;

    if (hasSeo) {
      totalSections++;
      if (d.seo !== null && d.seo !== undefined) decidedSections++;
      if (d.seo === 'approved') anyApproved = true;
    }
    if (hasAlt) {
      totalSections++;
      if (d.alt !== null && d.alt !== undefined) decidedSections++;
      if (d.alt === 'approved') anyApproved = true;
    }
    // If page has neither (e.g. only compress), count as auto-decided
    if (!hasSeo && !hasAlt) decidedSections++;
  }

  var allDone = totalSections === 0 || decidedSections >= totalSections;

  if (!allDone) {
    btn.disabled = true;
    hint.textContent = (totalSections - decidedSections) + ' section(s) still need a decision';
    return;
  }

  btn.disabled = false;
  if (!anyApproved) {
    btn.textContent = '▶ Submit (No Changes)';
    hint.textContent = 'All skipped — will send report with no changes';
  } else {
    btn.textContent = '▶ Commit Approved to WordPress';
    hint.textContent = 'Approved sections will be applied';
  }
}

// Submit decisions to /api/approve — sends per-section decisions
async function submitApprovals() {
  var pending = window.__PENDING__ || [];
  if (!pending.length) return;

  // Build granular decision list: [ { id, approveSeo, approveAlt } ]
  var decisions = [];
  var approvedIds = [];
  var rejectedIds = [];

  for (var i = 0; i < pending.length; i++) {
    var p   = pending[i];
    var d   = approvalDecisions[p.id] || {};
    var approveSeo = d.seo === 'approved';
    var approveAlt = d.alt === 'approved';

    decisions.push({ id: p.id, approveSeo: approveSeo, approveAlt: approveAlt });

    if (approveSeo || approveAlt) {
      approvedIds.push(p.id);
    } else {
      rejectedIds.push(p.id);
    }
  }

  var btn  = document.getElementById('commit-btn');
  var hint = document.getElementById('commit-hint');
  btn.disabled = true;
  btn.textContent = 'Committing...';
  if (hint) hint.textContent = 'Applying to WordPress — please wait...';

  isSubmitting = true;

  try {
    var res = await fetch('/api/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-secret': API_SECRET_CLIENT },
      body: JSON.stringify({ approved: approvedIds, rejected: rejectedIds, decisions: decisions })
    });
    var data = await res.json();
    console.log('Approve response:', data);

    // Reset all approval state
    isSubmitting = false; // FIX: clear guard
    approvalDecisions = {};
    panelRendered = false;
    window.__PENDING__ = [];

    document.getElementById('approval-panel').classList.remove('visible');
    document.getElementById('approval-items').innerHTML = '';

    // Resume polling — wasRunning=true so it keeps going until server is idle
    wasRunning = true;
    startPolling();

  } catch(e) {
    console.error('Failed to submit approvals', e);
    isSubmitting = false; // FIX: clear guard on error too
    btn.disabled = false;
    btn.textContent = '▶ Commit Approved to GitHub';
    if (hint) hint.textContent = 'Network error — please try again';
  }
}

// ── Main UI update ────────────────────────────────────────────────────────────
function updateUI(status, logsData) {
  var btn          = document.getElementById('run-btn');
  var btnText      = document.getElementById('btn-text');
  var statusDot    = document.getElementById('status-dot');
  var statusText   = document.getElementById('status-text');
  var scheduleInfo = document.getElementById('schedule-info');

  var isScanning = !!(status.isScanning || status.isRunning);
  var isCommitting  = !!status.isCommitting;
  var pending    = status.pendingApprovals || [];
  var hasPending = pending.length > 0;

  // FIX: Only lock in the pending list when scan is FULLY done.
  // While isScanning=true the server pushes items one-by-one, so pending is
  // incomplete. Updating __PENDING__ mid-scan caused the panel to render with
  // just the first item and then panelRendered=true blocked all further renders.
  if (!isScanning) {
    window.__PENDING__ = pending;
  }

  if (isScanning) {
    wasRunning = true;
    btn.disabled = true;
    btn.classList.add('running');
    var iconEl = document.getElementById('btn-icon');
    if (iconEl && iconEl.tagName !== 'DIV') {
      iconEl.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    }
    btnText.textContent = 'Scanning Pages...';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Scanning';
    // FIX: show live count of pages queued so far while scanning
    var queuedCount = pending.length;
    scheduleInfo.textContent = queuedCount > 0
      ? 'AI analyzing pages… ' + queuedCount + ' queued for review so far'
      : 'AI is analyzing your pages...';

  // FIX: Commit in-flight — keep spinner + logs streaming
  } else if (isCommitting) {
    wasRunning = true;
    btn.disabled = true;
    btn.classList.add('running');
    var iconElC = document.getElementById('btn-icon');
    if (iconElC && iconElC.tagName !== 'DIV') {
      iconElC.outerHTML = '<div class="spinner" id="btn-icon"></div>';
    }
    btnText.textContent = 'Committing to GitHub...';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Committing';
    scheduleInfo.textContent = 'Writing approved changes to GitHub & sending email...';
    if (!polling) startPolling();

  } else if (hasPending) {
    btn.disabled = false;
    btn.classList.remove('running');
    var icon2 = document.getElementById('btn-icon');
    if (icon2 && icon2.tagName === 'DIV') {
      icon2.outerHTML = '<span id="btn-icon">▶</span>';
    }
    btnText.textContent = 'Run SEO Monitor Now';
    statusDot.className = 'status-dot running';
    statusText.textContent = 'Awaiting Approval';
    scheduleInfo.textContent = 'Review suggestions below, then click Commit';

    // Stop polling while human reviews — panel is static
    if (polling) { clearInterval(polling); polling = null; }

  } else {
    btn.disabled = false;
    btn.classList.remove('running');
    var icon3 = document.getElementById('btn-icon');
    if (icon3 && icon3.tagName === 'DIV') {
      icon3.outerHTML = '<span id="btn-icon">▶</span>';
    }
    btnText.textContent = 'Run SEO Monitor Now';
    statusDot.className = 'status-dot idle';
    statusText.textContent = 'Idle';
    scheduleInfo.textContent = 'Runs automatically every day at 7:00 AM';

    if (wasRunning) {
      wasRunning = false;
      if (polling) { clearInterval(polling); polling = null; }
    }
  }

  // FIX: Only render the approval panel AFTER scanning is fully done.
  // Previously this ran during the scan too, which rendered the panel with
  // only the first queued item and then panelRendered=true blocked re-renders.
  if (!isScanning && !isCommitting) {
    maybeRenderApprovalPanel(pending);
  }

  // Stats
  if (status.lastResult) {
    var r = status.lastResult;
    var updEl  = document.getElementById('stat-updated');
    var goodEl = document.getElementById('stat-good');
    var errEl  = document.getElementById('stat-errors');
    if (updEl)  updEl.textContent  = r.changed;
    if (goodEl) goodEl.textContent = r.skipped;
    if (errEl)  errEl.textContent  = r.errors;

    var lastRunEl = document.getElementById('last-run');
    if (lastRunEl) lastRunEl.style.display = 'flex';
    var lastRunDate = document.getElementById('last-run-date');
    if (lastRunDate) lastRunDate.textContent = r.runDate + ' · ' + r.duration + 's';

    var pills = document.getElementById('result-pills');
    if (pills) {
      pills.innerHTML =
        '<span class="pill pill-green">✓ ' + r.changed + ' updated</span>' +
        '<span class="pill pill-purple">◎ ' + r.skipped + ' good</span>' +
        (r.errors > 0 ? '<span class="pill pill-red">✗ ' + r.errors + ' errors</span>' : '');
    }
  }

  // Logs
  var logsBody = document.getElementById('logs-body');
  var logCount = document.getElementById('log-count');
  if (logsData.logs && logsData.logs.length > 0) {
    if (logCount) logCount.textContent = logsData.logs.length + ' lines';
    if (logsBody) {
      logsBody.innerHTML = logsData.logs.map(function(l) {
        var time = new Date(l.time).toLocaleTimeString('en-US', { hour12: false });
        return '<div class="log-line"><span class="log-time">' + time +
          '</span><span class="log-msg ' + l.type + '">' + escapeHtml(l.msg) + '</span></div>';
      }).join('');
      logsBody.scrollTop = logsBody.scrollHeight;
    }
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

startPolling();
