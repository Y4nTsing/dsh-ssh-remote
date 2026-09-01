/* ssh-remote preset — terminal panel, embedded as a third view tab next to
 * 对话/轨迹 in each conversation header, with a floating right-panel fallback
 * when the GUI's tab bar cannot be found. Session switching is a dropdown;
 * the record matching the conversation being viewed is marked 当前会话.
 *
 * Endpoints (same-origin, provided by the preset plugin):
 *   GET  /ssh-remote-panel/sessions?titleHint=<breadcrumb title>
 *   GET  /ssh-remote-panel/transcript?file=<journal>&offset=<chars>
 *   GET  /ssh-remote-panel/jobs[?agent=<id>]
 *   GET  /ssh-remote-panel/job?id=<jobId>[&agent=<id>]&offset=<chars>
 *   POST /ssh-remote-panel/job-kill   {id}                                  */
(function () {
  'use strict'
  if (window.__dsrPanelLoaded) return
  window.__dsrPanelLoaded = true

  var LS_WIDTH = 'dsrPanel.width'
  var LS_OPEN = 'dsrPanel.open'
  var MAX_LINES = 6000
  var POLL_MS = 1200

  var sessionRows = []
  var activeFile = null        /* transcriptFile key of the shown session */
  var manualChoice = false     /* user picked a session explicitly */
  var term = null
  var termState = { cursor: 0, partial: '', prompts: [], follow: true, jumpCount: -1 }
  var jobs = new Map()
  var subTab = 'term'          /* term | jobs */
  var selectedJob = null
  var selectedJobAgent = null
  var jobCursor = 0
  var jobFollow = true
  var jobPartial = ''
  var tick = 0
  var hadRows = false
  var storedOpen = null
  var currentIsSsh = false   /* backend: the viewed conversation runs ssh-remote */

  /* ---------- shared content (one instance, two possible hosts) ---------- */
  var content = document.createElement('div')
  content.id = 'dsr-content'
  content.innerHTML =
    '<div class="dsr-head">' +
    '  <span id="dsr-conn"><i></i><em>—</em></span>' +
    '  <select id="dsr-session" title="切换会话记录"></select>' +
    '  <select id="dsr-jump" title="跳转到命令"></select>' +
    '  <span class="dsr-spacer"></span>' +
    '  <button id="dsr-follow" class="on" title="自动滚动到最新">跟随</button>' +
    '</div>' +
    '<div class="dsr-subtabs">' +
    '  <div class="dsr-subtab active" data-sub="term">终端</div>' +
    '  <div class="dsr-subtab" data-sub="jobs">Jobs <span id="dsr-jobbadge" class="dsr-badge" style="display:none"></span></div>' +
    '</div>' +
    '<div class="dsr-bodies">' +
    '  <div class="dsr-body active" id="dsr-term-body"><div class="dsr-term" id="dsr-term" tabindex="0"></div></div>' +
    '  <div class="dsr-body" id="dsr-jobs-body">' +
    '    <div class="dsr-jobs-list" id="dsr-jobs-list"></div>' +
    '    <div class="dsr-job-detail">' +
    '      <div class="dsr-job-head">' +
    '        <span id="dsr-jd-state">—</span>' +
    '        <span id="dsr-jd-title"></span>' +
    '        <span class="dsr-spacer"></span>' +
    '        <button id="dsr-jd-locate" title="在该会话终端中定位任务">⇱ 定位</button>' +
    '        <button id="dsr-jd-kill">终止</button>' +
    '        <button id="dsr-jd-follow" class="on">跟随</button>' +
    '      </div>' +
    '      <div class="dsr-term" id="dsr-job-term"></div>' +
    '    </div>' +
    '  </div>' +
    '</div>' +
    '<button id="dsr-bottom">↓ 回到底部</button>'

  term = content.querySelector('#dsr-term')
  var jobTerm = content.querySelector('#dsr-job-term')
  var $c = function (sel) { return content.querySelector(sel) }

  /* ---------- floating host (fallback) ---------- */
  var root = document.createElement('div')
  root.id = 'dsr-panel-root'
  root.innerHTML =
    '<div id="dsr-panel">' +
    '  <div id="dsr-grip" title="拖动调整宽度；双击复位"></div>' +
    '  <div class="dsr-floatbar"><span class="dsr-title">SSH Remote</span><span class="dsr-spacer"></span>'
    + '<button id="dsr-collapse" title="收起面板">»</button></div>' +
    '</div>' +
    '<div id="dsr-edge" title="展开 SSH 终端面板">❯ SSH 终端</div>'
  root.querySelector('#dsr-panel').appendChild(content)
  var attachRoot = function () {
    if (document.body) document.body.appendChild(root)
    else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(root) })
  }
  attachRoot()

  function applyOpen(open) {
    root.classList.toggle('open', open)
    try { localStorage.setItem(LS_OPEN, open ? '1' : '0') } catch (_) {}
  }
  try { storedOpen = localStorage.getItem(LS_OPEN) } catch (_) {}
  if (storedOpen === '0') root.classList.remove('open')
  root.querySelector('#dsr-edge').addEventListener('click', function () { applyOpen(true) })
  root.querySelector('#dsr-collapse').addEventListener('click', function () { applyOpen(false) })
  function applyWidth(px) {
    root.querySelector('#dsr-panel').style.width = Math.max(320, Math.min(760, px)) + 'px'
    try { localStorage.setItem(LS_WIDTH, root.querySelector('#dsr-panel').style.width) } catch (_) {}
  }
  try {
    var w = parseInt(localStorage.getItem(LS_WIDTH) || '', 10)
    if (w >= 320 && w <= 760) applyWidth(w)
  } catch (_) {}
  var drag = null
  root.querySelector('#dsr-grip').addEventListener('mousedown', function (e) { drag = { x: e.clientX, w: root.querySelector('#dsr-panel').offsetWidth }; e.preventDefault() })
  window.addEventListener('mousemove', function (e) { if (drag) applyWidth(drag.w + (drag.x - e.clientX)) })
  window.addEventListener('mouseup', function () { drag = null })
  root.querySelector('#dsr-grip').addEventListener('dblclick', function () { applyWidth(460) })

  var standalone = window.location.pathname.indexOf('/ssh-remote-panel') === 0
  if (standalone) {
    var sp = root.querySelector('#dsr-panel')
    sp.style.width = '100%'; sp.style.borderLeft = 'none'; sp.style.position = 'static'
    root.querySelector('#dsr-edge').style.display = 'none'
    applyOpen(true)
  }

  /* ---------- line rendering ---------- */
  var TS_RE = /^(\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\])\s?(.*)$/
  var JOB_ID_RE = /\bssh-[a-zA-Z0-9-]+\b/

  function classify(rest) {
    if (/^===.*===$/.test(rest)) return 'banner'
    if (rest.charAt(0) === '$') return 'prompt'
    if (rest.charAt(0) === '#') return 'note'
    if (/^\(background/.test(rest)) return 'bg'
    if (rest.charAt(0) === '[' && rest.charAt(rest.length - 1) === ']') {
      if (/\[exit code: 0\]/.test(rest) || /^\[transcript/.test(rest)) return 'ok'
      if (/error|timed out|killed|truncated|dropped|failed/i.test(rest)) return 'err'
      return 'dim'
    }
    return 'plain'
  }

  function renderLine(text) {
    var m = TS_RE.exec(text)
    var ts = m ? m[1] : ''
    var rest = m ? m[2] : text
    var kind = classify(rest)
    var line = document.createElement('div')
    line.className = 'dsr-l dsr-' + kind
    var mid = JOB_ID_RE.exec(rest)
    if (mid !== null) line.dataset.job = mid[0]
    if (ts) {
      var t = document.createElement('span')
      t.className = 'dsr-ts'
      t.textContent = ts + ' '
      line.appendChild(t)
    }
    if (kind === 'prompt') {
      var d = document.createElement('span')
      d.className = 'dsr-dollar'
      d.textContent = '$ '
      line.appendChild(d)
      var c = document.createElement('span')
      c.className = 'dsr-cmd'
      c.textContent = rest.replace(/^\$\s?/, '')
      line.appendChild(c)
      termState.prompts.push({ el: line, label: (ts || '') + ' ' + rest.replace(/^\$\s?/, '') })
    } else {
      line.appendChild(document.createTextNode(rest))
    }
    return line
  }

  function appendChunk(text) {
    if (!text) return
    var buf = termState.partial + text
    var lines = buf.split('\n')
    termState.partial = lines.pop()
    var frag = document.createDocumentFragment()
    for (var i = 0; i < lines.length; i++) frag.appendChild(renderLine(lines[i]))
    term.appendChild(frag)
    while (term.childElementCount > MAX_LINES) term.removeChild(term.firstChild)
    if (termState.follow) term.scrollTop = term.scrollHeight
  }

  function clearTerm() {
    term.textContent = ''
    termState = { cursor: 0, partial: '', prompts: [], follow: true, jumpCount: -1 }
    rebuildJump()
  }

  /* ---------- subtabs ---------- */
  content.querySelectorAll('.dsr-subtab').forEach(function (el) {
    el.addEventListener('click', function () { switchSub(el.dataset.sub) })
  })
  function switchSub(sub) {
    subTab = sub
    content.querySelectorAll('.dsr-subtab').forEach(function (el) { el.classList.toggle('active', el.dataset.sub === sub) })
    content.querySelector('#dsr-term-body').classList.toggle('active', sub === 'term')
    content.querySelector('#dsr-jobs-body').classList.toggle('active', sub === 'jobs')
    if (sub === 'jobs' && selectedJob === null) {
      var first = null
      jobs.forEach(function (j) { if (first === null || ((j.startedAt ?? 0) > (first.startedAt ?? 0))) first = j })
      if (first !== null) selectJob(first.id, first.agentId)
    }
    if (sub === 'term' && termState.follow) term.scrollTop = term.scrollHeight
  }

  /* ---------- follow / jump / bottom ---------- */
  term.addEventListener('scroll', function () {
    termState.follow = term.scrollTop + term.clientHeight >= term.scrollHeight - 36
    $c('#dsr-follow').classList.toggle('on', termState.follow)
    $c('#dsr-bottom').style.display = (subTab === 'term' && !termState.follow) ? 'block' : 'none'
  })
  $c('#dsr-follow').addEventListener('click', function () {
    termState.follow = true
    $c('#dsr-follow').classList.add('on')
    term.scrollTop = term.scrollHeight
  })
  $c('#dsr-bottom').addEventListener('click', function () {
    termState.follow = true
    term.scrollTop = term.scrollHeight
    $c('#dsr-bottom').style.display = 'none'
  })

  function rebuildJump() {
    var sel = $c('#dsr-jump')
    sel.innerHTML = ''
    var opt = document.createElement('option')
    opt.value = ''
    opt.textContent = '⇢ 跳转到命令…'
    sel.appendChild(opt)
    var start = Math.max(0, termState.prompts.length - 300)
    for (var i = start; i < termState.prompts.length; i++) {
      var o = document.createElement('option')
      o.value = String(i)
      o.textContent = termState.prompts[i].label.slice(0, 64)
      sel.appendChild(o)
    }
    termState.jumpCount = termState.prompts.length
  }
  $c('#dsr-jump').addEventListener('change', function (e) {
    var p = termState.prompts[+e.target.value]
    if (p) {
      p.el.scrollIntoView({ block: 'start' })
      termState.follow = false
    }
    e.target.blur()
  })

  /* job-jump from transcript lines: resolve the id against the session
   * currently shown (ids collide across sessions — ssh-1 everywhere) */
  content.addEventListener('click', function (e) {
    var line = e.target && e.target.closest ? e.target.closest('[data-job]') : null
    if (line === null || line === undefined) return
    switchSub('jobs')
    var row = sessionRows.find(function (r) { return rowKey(r) === activeFile })
    selectJob(line.dataset.job, row !== undefined ? row.agentId : null)
  })

  /* ---------- jobs ---------- */
  var jobsList = $c('#dsr-jobs-list')
  jobTerm.addEventListener('scroll', function () {
    jobFollow = jobTerm.scrollTop + jobTerm.clientHeight >= jobTerm.scrollHeight - 36
    $c('#dsr-jd-follow').classList.toggle('on', jobFollow)
  })
  $c('#dsr-jd-follow').addEventListener('click', function () {
    jobFollow = true
    $c('#dsr-jd-follow').classList.add('on')
    jobTerm.scrollTop = jobTerm.scrollHeight
  })
  $c('#dsr-jd-kill').addEventListener('click', function () {
    if (selectedJob === null) return
    fetch('/ssh-remote-panel/job-kill', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: selectedJob }),
    }).then(refreshJobs).catch(function () {})
  })
  function jobKey(id, agentId) { return String(agentId) + '/' + String(id) }

  $c('#dsr-jd-locate').addEventListener('click', function () {
    if (selectedJob === null) return
    var j = jobs.get(jobKey(selectedJob, selectedJobAgent))
    if (j === undefined) return
    var row = rowByAgent(j.agentId)
    if (row === null) return
    switchSession(row, true)
    tryLocate(j.id, 0)
  })

  function tryLocate(jobId, tries) {
    var el = term.querySelector('[data-job="' + jobId + '"]')
    if (el !== null) {
      el.scrollIntoView({ block: 'center' })
      termState.follow = false
      el.classList.remove('dsr-flash')
      void el.offsetWidth
      el.classList.add('dsr-flash')
      return
    }
    if (tries < 5) setTimeout(function () { pollTerm().then(function () { tryLocate(jobId, tries + 1) }) }, 450)
  }

  function fmtElapsed(ms) {
    if (typeof ms !== 'number' || !isFinite(ms)) return ''
    var s = Math.max(0, Math.floor(ms / 1000))
    var m = Math.floor(s / 60)
    return m + ':' + String(s % 60).padStart(2, '0')
  }

  function stateText(j) {
    return '#' + j.id + ' ' + (j.status === 'running' ? '● running'
      : j.status === 'killed' ? '⊘ killed'
      : j.status === 'failed' ? '✖ failed'
      : '✓ done')
  }

  function renderJobsList() {
    jobsList.textContent = ''
    if (jobs.size === 0) {
      var empty = document.createElement('div')
      empty.className = 'dsr-jobs-empty'
      empty.textContent = '暂无托管后台任务（ssh_bash run_in_background）'
      jobsList.appendChild(empty)
      return
    }
    var rows = []
    jobs.forEach(function (j) { rows.push(j) })
    rows.sort(function (a, b) { return (b.startedAt ?? 0) - (a.startedAt ?? 0) })
    rows.forEach(function (j) {
      var el = document.createElement('div')
      el.className = 'dsr-job st-' + j.status + (jobKey(j.id, j.agentId) === jobKey(selectedJob, selectedJobAgent) && selectedJob !== null ? ' sel' : '')
      var info
      if (j.status === 'running') info = '● ' + fmtElapsed(Date.now() - (j.startedAt ?? Date.now()))
      else if (j.status === 'killed') info = '⊘ killed'
      else if (j.status === 'failed') info = '✖ failed'
      else info = '✓ ' + fmtElapsed((j.endedAt ?? 0) - (j.startedAt ?? 0)) + (j.detail ? ' · ' + j.detail : '')
      var idEl = document.createElement('b')
      idEl.textContent = '#' + j.id
      var cmdEl = document.createElement('span')
      cmdEl.className = 'dsr-jcmd'
      cmdEl.textContent = ' ' + j.label + ' '
      var infoEl = document.createElement('span')
      infoEl.className = 'dsr-jinfo'
      infoEl.textContent = info
      el.appendChild(idEl)
      el.appendChild(cmdEl)
      el.appendChild(infoEl)
      var locate = document.createElement('button')
      locate.textContent = '⇱'
      locate.title = '在该会话终端中定位任务'
      locate.addEventListener('click', function (ev) {
        ev.stopPropagation()
        var row = rowByAgent(j.agentId)
        if (row !== null) { switchSession(row, true); tryLocate(j.id, 0) }
      })
      el.appendChild(locate)
      if (j.status === 'running') {
        var kill = document.createElement('button')
        kill.textContent = '终止'
        kill.addEventListener('click', function (ev) {
          ev.stopPropagation()
          fetch('/ssh-remote-panel/job-kill', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: j.id }),
          }).then(refreshJobs).catch(function () {})
        })
        el.appendChild(kill)
      }
      var sess = rowByAgent(j.agentId)
      el.title = (sess && sess.userAtHost ? sess.userAtHost : j.agentId) + (j.historical ? ' · 历史任务' : '')
      el.addEventListener('click', function () { selectJob(j.id, j.agentId) })
      jobsList.appendChild(el)
    })
  }

  function selectJob(id, agentId) {
    selectedJob = id
    selectedJobAgent = agentId
    jobPartial = ''
    jobCursor = 0
    jobTerm.textContent = ''
    var j = id !== null ? jobs.get(jobKey(id, agentId)) : undefined
    var stateEl = $c('#dsr-jd-state')
    if (j === undefined) {
      stateEl.textContent = '#' + id
      stateEl.className = ''
      $c('#dsr-jd-title').textContent = '（未找到该任务的记录）'
      $c('#dsr-jd-kill').style.display = 'none'
      $c('#dsr-jd-locate').style.display = 'none'
      renderJobsList()
      return
    }
    stateEl.textContent = stateText(j)
    stateEl.className = 'st-' + j.status
    $c('#dsr-jd-title').textContent = j.label + (j.historical ? '（历史）' : '')
    $c('#dsr-jd-kill').style.display = j.status === 'running' ? '' : 'none'
    $c('#dsr-jd-locate').style.display = ''
    renderJobsList()
    pollJobOutput().catch(function () {})
  }

  function pollJobOutput() {
    if (selectedJob === null) return Promise.resolve()
    var url = '/ssh-remote-panel/job?id=' + encodeURIComponent(selectedJob)
      + (selectedJobAgent !== null ? '&agent=' + encodeURIComponent(selectedJobAgent) : '')
      + '&offset=' + jobCursor
    return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (data) {
      if (!data || typeof data.length !== 'number') return
      if (data.reset || data.length < jobCursor) { jobTerm.textContent = ''; jobPartial = '' }
      if (data.text) {
        var buf = jobPartial + data.text
        var lines = buf.split('\n')
        jobPartial = lines.pop()
        var frag = document.createDocumentFragment()
        for (var i = 0; i < lines.length; i++) {
          var d = document.createElement('div')
          d.className = 'dsr-l'
          d.textContent = lines[i]
          frag.appendChild(d)
        }
        jobTerm.appendChild(frag)
        while (jobTerm.childElementCount > MAX_LINES) jobTerm.removeChild(jobTerm.firstChild)
        if (jobFollow) jobTerm.scrollTop = jobTerm.scrollHeight
      }
      jobCursor = data.length
    })
  }

  /* ---------- sessions ---------- */
  function rowKey(row) {
    return row.transcriptFile !== null && row.transcriptFile !== undefined ? row.transcriptFile : ('live:' + row.agentId)
  }
  function rowByAgent(agentId) {
    for (var i = 0; i < sessionRows.length; i++) {
      if (sessionRows[i].agentId === agentId) return sessionRows[i]
    }
    return null
  }

  function switchSession(row, manual) {
    if (manual) manualChoice = true
    var key = rowKey(row)
    if (activeFile === key) return
    activeFile = key
    clearTerm()
    updateConn(row)
    pollTerm().catch(function () {})
  }

  function updateConn(row) {
    var conn = $c('#dsr-conn')
    conn.classList.toggle('on', !!(row && row.connected))
    conn.querySelector('em').textContent = row
      ? (row.connected ? '已连接' : (row.historical ? '历史' : '已断开'))
      : '—'
  }

  function renderSessionSelect() {
    var sel = $c('#dsr-session')
    sel.innerHTML = ''
    if (sessionRows.length === 0) {
      var o0 = document.createElement('option')
      o0.value = ''
      o0.textContent = '（暂无 ssh-remote 会话记录）'
      sel.appendChild(o0)
      return
    }
    sessionRows.forEach(function (row) {
      var o = document.createElement('option')
      o.value = rowKey(row)
      var mark = row.current ? '★ ' : ''
      o.textContent = mark + row.label.replace(/^[○●]\s*/, '')
      o.title = (row.workspace ?? '') + '\n' + (row.transcriptFile ?? '')
      sel.appendChild(o)
    })
    if (activeFile !== null) {
      var exists = sessionRows.some(function (r) { return rowKey(r) === activeFile })
      if (exists) sel.value = activeFile
    }
  }

  $c('#dsr-session').addEventListener('change', function (e) {
    var row = sessionRows.find(function (r) { return rowKey(r) === e.target.value })
    if (row !== undefined) switchSession(row, true)
  })

  /* ---------- polling ---------- */
  function currentTitleHint() {
    // Primary: the conversation header's breadcrumb (the current session's
    // display title). Fallback: the page title, which embeds the same title
    // (backend matching is substring-tolerant of surrounding text).
    var navText = ''
    var header = document.querySelector('header [role="tablist"]')
    if (header !== null) {
      var headerEl = header.closest('header')
      var nav = headerEl !== null ? headerEl.querySelector('nav') : null
      if (nav !== null) {
        var crumbs = nav.querySelectorAll('button')
        var last = crumbs.length > 0 ? crumbs[crumbs.length - 1].textContent : nav.textContent
        navText = (last ?? '').trim()
      }
    }
    if (navText !== '') return navText.slice(0, 200)
    return (document.title || '').trim().slice(0, 200)
  }

  function refreshSessions() {
    var hint = currentTitleHint()
    var qs = standalone ? 'all=1' : (hint !== '' ? 'titleHint=' + encodeURIComponent(hint) : '')
    var url = '/ssh-remote-panel/sessions' + (qs !== '' ? '?' + qs : '')
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        var rows = Array.isArray(data) ? data : (data != null && Array.isArray(data.sessions) ? data.sessions : [])
        currentIsSsh = data != null && data.currentIsSsh === true
        sessionRows = rows
        root.classList.toggle('available', sessionRows.length > 0)
        if (sessionRows.length > 0 && !hadRows) {
          hadRows = true
          if (storedOpen === null) applyOpen(sessionRows.some(function (r) { return r.connected }))
        }
        if (sessionRows.length === 0) hadRows = false
        renderSessionSelect()
        if (!manualChoice) {
          var pick = sessionRows.find(function (r) { return r.current })
            ?? sessionRows.find(function (r) { return r.connected })
            ?? sessionRows[0]
          if (pick !== undefined) switchSession(pick, false)
        } else {
          var cur = sessionRows.find(function (r) { return rowKey(r) === activeFile })
          if (cur === undefined && sessionRows.length > 0) {
            manualChoice = false
            var pick2 = sessionRows.find(function (r) { return r.current }) ?? sessionRows[0]
            switchSession(pick2, false)
          } else if (cur !== undefined) {
            updateConn(cur)
          }
        }
      })
  }

  function pollTerm() {
    if (activeFile === null || subTab !== 'term') return Promise.resolve()
    return fetch('/ssh-remote-panel/transcript?file=' + encodeURIComponent(activeFile) + '&offset=' + termState.cursor, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (data) {
        if (!data || typeof data.length !== 'number') return
        if (data.reset || data.length < termState.cursor) {
          term.textContent = ''
          termState.partial = ''
          termState.prompts = []
        }
        if (data.text) appendChunk(data.text)
        termState.cursor = data.length
        if (termState.prompts.length !== termState.jumpCount) rebuildJump()
        $c('#dsr-bottom').style.display = !termState.follow ? 'block' : 'none'
      })
  }

  function refreshJobs() {
    // Same scoping as /sessions: the standalone page sees everything; an
    // embedded panel scopes to the current conversation's workspace.
    var hint = currentTitleHint()
    var url = '/ssh-remote-panel/jobs'
      + (standalone ? '?all=1' : (hint !== '' ? '?titleHint=' + encodeURIComponent(hint) : ''))
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (rows) {
        jobs = new Map()
        ;(rows || []).forEach(function (j) { jobs.set(jobKey(j.id, j.agentId), j) })
        var running = 0
        jobs.forEach(function (j) { if (j.status === 'running') running += 1 })
        var badge = $c('#dsr-jobbadge')
        badge.textContent = String(running)
        badge.style.display = running > 0 ? '' : 'none'
        renderJobsList()
        if (selectedJob !== null) {
          var j = jobs.get(jobKey(selectedJob, selectedJobAgent))
          if (j !== undefined) {
            var stateEl = $c('#dsr-jd-state')
            stateEl.textContent = stateText(j)
            stateEl.className = 'st-' + j.status
            $c('#dsr-jd-kill').style.display = j.status === 'running' ? '' : 'none'
          }
        }
      })
  }

  /* ================================================================
   * Embedded third tab: injected next to 对话/轨迹 in the conversation
   * header. Purely DOM-level: clone tab styling, toggle sibling
   * visibility. If the GUI's structure changes, we fall back to the
   * floating panel automatically.
   * =============================================================== */
  var embed = { btn: null, tablist: null, host: null, container: null, active: false, hidden: [], activeTokens: [] }

  function findViewTablist() {
    var lists = document.querySelectorAll('[role="tablist"]')
    var fallback = null
    for (var i = 0; i < lists.length; i++) {
      var tl = lists[i]
      if (tl.querySelector('[data-dsr-tab]')) return tl
      // Tabs may be nested, not direct children; the label check is a plain
      // text scan of every tab in the list.
      var tabs = tl.querySelectorAll('[role="tab"]')
      var sawTrajectory = false
      var sawConversation = false
      for (var k = 0; k < tabs.length; k++) {
        var text = tabs[k].textContent || ''
        if (/轨迹|Trajectory/i.test(text)) sawTrajectory = true
        if (/对话|Conversation|Chat/i.test(text)) sawConversation = true
      }
      if (sawTrajectory) return tl
      if (sawConversation && fallback === null) fallback = tl
    }
    return fallback
  }

  function classTokensOf(el) { return (el && el.className ? String(el.className) : '').split(/\s+/).filter(Boolean) }

  function injectTab() {
    var tl = findViewTablist()
    if (tl === null) return
    embed.tablist = tl
    if (!currentIsSsh) {
      // Not an ssh-remote conversation: the tab must not exist here.
      unmountTab()
      return
    }
    if (tl.querySelector('[data-dsr-tab]') === null) {
      var tabs = tl.querySelectorAll('[role="tab"]')
      var inactive = null
      var active = null
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].getAttribute('aria-selected') === 'true') active = tabs[i]
        else if (inactive === null) inactive = tabs[i]
      }
      var sample = inactive ?? active ?? tabs[0]
      if (sample === undefined || sample === null) return
      var base = classTokensOf(inactive ?? sample)
      var activeAll = classTokensOf(active ?? sample)
      embed.activeTokens = activeAll.filter(function (t) { return base.indexOf(t) < 0 })
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.setAttribute('aria-selected', 'false')
      btn.setAttribute('data-dsr-tab', '1')
      btn.className = base.join(' ')
      btn.textContent = 'SSH 终端'
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        if (embed.active) deactivateEmbed(false)
        else activateEmbed()
      })
      tl.appendChild(btn)
      embed.btn = btn
      tl.addEventListener('click', function (e) {
        var t = e.target && e.target.closest ? e.target.closest('[role="tab"]') : null
        if (t !== null && !t.hasAttribute('data-dsr-tab') && embed.active) deactivateEmbed(false)
      }, true)
    } else {
      embed.btn = tl.querySelector('[data-dsr-tab]')
    }
    var header = tl.closest('header') ?? tl.parentElement
    // The header's immediate parent may be a display:contents wrapper that
    // generates NO box (clientHeight 0) — walk up to the first ancestor
    // that actually lays out, and take over THERE.
    var box = header !== null ? header.parentElement : null
    try {
      while (box !== null && box !== document.body && window.getComputedStyle(box).display === 'contents') {
        box = box.parentElement
      }
    } catch (_) {}
    embed.headerWrapper = header !== null ? header.parentElement : null
    embed.host = box
    if (embed.host !== null && embed.container === null) {
      var c = document.createElement('div')
      c.id = 'dsr-embed'
      c.style.display = 'none'
      embed.container = c
      embed.host.appendChild(c)
    }
  }

  /** React re-renders detach our references silently: a removed subtree's
   * elements still have parentElement set. isConnected is the honest check. */
  function embedRefsAlive() {
    return embed.btn !== null && embed.btn.isConnected
      && embed.container !== null && embed.container.isConnected
      && embed.host !== null && embed.host.isConnected
  }

  function unmountTab() {
    if (embed.active) deactivateEmbed(false)
    if (embed.btn !== null && embed.btn.parentElement !== null) embed.btn.remove()
    embed.btn = null
    if (embed.container !== null && embed.container.parentElement !== null) {
      embed.container.style.display = 'none'
    }
  }

  /** Size the embed container EXPLICITLY against the box-generating host:
   * height = host content height − header footprint, recomputed every
   * reassert and on window resize. Normal flow, no position games. */
  function placeEmbed() {
    if (embed.host === null || embed.container === null || !embed.host.isConnected) return
    var host = embed.host
    var header = embed.tablist !== null && embed.tablist.isConnected ? embed.tablist.closest('header') : null
    var headerH = header !== null && (header.parentElement === host || embed.headerWrapper !== null) ? header.offsetHeight : 0
    var cs = null
    try {
      cs = window.getComputedStyle(host)
    } catch (_) {}
    var padT = cs !== null ? (parseFloat(cs.paddingTop) || 0) : 0
    var padB = cs !== null ? (parseFloat(cs.paddingBottom) || 0) : 0
    var avail = host.clientHeight - padT - padB - headerH
    var s = embed.container.style
    s.position = ''
    s.left = ''
    s.right = ''
    s.top = ''
    s.bottom = ''
    s.width = '100%'
    s.height = `${Math.max(160, avail)}px`
  }
  window.addEventListener('resize', function () {
    if (embed.active) placeEmbed()
  })

  /** The header wrapper (display:contents or not) keeps its place; every
   * OTHER in-flow child of the box host is the conversation surface we
   * replace while the terminal is active. */
  function protectedChild(child) {
    if (child === embed.container) return true
    if (child === embed.headerWrapper) return true
    if (child.tagName === 'HEADER') return true
    if (embed.headerWrapper !== null && embed.headerWrapper.contains(child)) return true
    return false
  }

  function activateEmbed() {
    if (embed.btn === null || embed.host === null) return
    embed.active = true
    if (embed.container.parentElement !== embed.host) embed.host.appendChild(embed.container)
    if (content.parentElement !== embed.container) embed.container.appendChild(content)
    embed.container.style.display = ''
    placeEmbed()
    embed.hidden = []
    var children = embed.host.children
    for (var i = 0; i < children.length; i++) {
      var child = children[i]
      if (protectedChild(child)) continue
      // The terminal view replaces the conversation completely (composer
      // included). display:none — unlike visibility — frees the space, so
      // hidden-but-tall siblings cannot push the page into overflow.
      if (child.style.display !== 'none') {
        child.style.display = 'none'
        embed.hidden.push(child)
      }
    }
    var tl = embed.tablist
    if (tl !== null) {
      tl.querySelectorAll('[role="tab"]').forEach(function (b) {
        if (b.hasAttribute('data-dsr-tab')) {
          b.setAttribute('aria-selected', 'true')
          embed.activeTokens.forEach(function (t) { b.classList.add(t) })
        } else {
          b.setAttribute('aria-selected', 'false')
          embed.activeTokens.forEach(function (t) { b.classList.remove(t) })
        }
      })
    }
    refreshSessions().then(refreshJobs).then(function () {
      placeEmbed()
      if (termState.follow) term.scrollTop = term.scrollHeight
    }).catch(function () {})
  }

  function deactivateEmbed(skipVisual) {
    embed.active = false
    embed.hidden.forEach(function (el) { el.style.display = '' })
    embed.hidden = []
    if (embed.container !== null) embed.container.style.display = 'none'
    if (!skipVisual && embed.btn !== null) {
      embed.btn.setAttribute('aria-selected', 'false')
      embed.activeTokens.forEach(function (t) { embed.btn.classList.remove(t) })
    }
  }

  function reassertEmbed() {
    injectTab()
    if (embed.active) {
      if (!embedRefsAlive()) {
        // React re-rendered the subtree away: rebuild against the CURRENT
        // tablist/header and re-activate.
        embed.active = false
        embed.container = null
        embed.btn = null
        embed.hidden = []
        injectTab()
        activateEmbed()
        return
      }
      // Keep the container sized against the (possibly re-rendered) layout
      // and re-hide any sibling React recreated without our display:none.
      placeEmbed()
      if (embed.host !== null) {
        var children = embed.host.children
        for (var i = 0; i < children.length; i++) {
          var child = children[i]
          if (protectedChild(child)) continue
          if (child.style.display !== 'none') {
            child.style.display = 'none'
            embed.hidden.push(child)
          }
        }
      }
    }
    // Never leave a stuck-active tab: clear our visuals whenever inactive.
    if (!embed.active && embed.btn !== null && embed.btn.getAttribute('aria-selected') === 'true') {
      embed.btn.setAttribute('aria-selected', 'false')
      embed.activeTokens.forEach(function (t) { embed.btn.classList.remove(t) })
    }
    // The floating host stays retired whenever the GUI has a view tablist
    // (embedding capability), even if the current conversation is not ssh.
    root.classList.toggle('embedded', findViewTablist() !== null)
  }

  setInterval(function () {
    if (standalone) return
    reassertEmbed()
  }, 1000)

  /* Conversation switches must feel instant, not wait for the next poll:
   * DOM mutations (breadcrumb/title change, tab re-render) trigger an
   * immediate refresh + re-assert, debounced. Mutations inside our own
   * containers (terminal lines, job rows) are ignored to avoid loops. */
  var lastHintSeen = ''
  var domDebounce = null
  var domObserver = new MutationObserver(function (records) {
    if (standalone) return
    var relevant = false
    for (var i = 0; i < records.length; i++) {
      var target = records[i].target
      var insideOwn = false
      if (typeof Element !== 'undefined' && target instanceof Element) {
        insideOwn = target.closest('#dsr-panel-root, #dsr-embed, #dsr-content') !== null
          || target.hasAttribute('data-dsr-tab')
      }
      if (!insideOwn) { relevant = true; break }
    }
    if (!relevant) return
    if (domDebounce !== null) return
    domDebounce = setTimeout(function () {
      domDebounce = null
      if (document.visibilityState === 'hidden') return
      var hint = currentTitleHint()
      if (hint !== lastHintSeen || embed.btn === null) {
        lastHintSeen = hint
        refreshSessions().then(reassertEmbed).catch(function () {})
      } else {
        reassertEmbed()
      }
    }, 150)
  })
  try {
    domObserver.observe(document.body, { childList: true, subtree: true })
  } catch (_) {}

  /* ---------- main loop ---------- */
  setInterval(function () {
    if (document.visibilityState === 'hidden') return
    // No visibility gate: gating polling on the panel being open deadlocks
    // (a closed floating panel would never learn that an ssh session went
    // live, so the embedded tab would never mount).
    tick += 1
    var p = Promise.resolve()
    if (tick % 3 === 1) p = p.then(refreshSessions)
    if (tick % 2 === 0) p = p.then(refreshJobs)
    if (subTab === 'jobs') {
      if (embed.active || standalone) {
        p = p.then(pollJobOutput)
        if (tick % 2 === 1) renderJobsList()
      }
    } else if (embed.active || standalone || (root.classList.contains('open') && !root.classList.contains('embedded'))) {
      p = p.then(pollTerm)
    }
    p.catch(function () {})
  }, POLL_MS)

  /* ---------- DOM diagnostics (written to the preset's panel-debug.log via
   * the backend) so structural mismatches with the GUI are visible offline
   * without guessing. Runs every ~12s and once shortly after load. ---------- */
  function collectDiag() {
    try {
      var tablists = []
      document.querySelectorAll('[role="tablist"]').forEach(function (tl) {
        if (tablists.length >= 6) return
        var tabs = []
        tl.querySelectorAll('[role="tab"]').forEach(function (b) {
          if (tabs.length < 6) tabs.push((b.textContent || '').trim().slice(0, 14))
        })
        tablists.push({
          label: tl.getAttribute('aria-label') ?? null,
          tabs: tabs,
          ours: tl.querySelector('[data-dsr-tab]') !== null,
        })
      })
      var nav = null
      var headerEl = document.querySelector('header [role="tablist"]')
      if (headerEl !== null) {
        var navEl = (headerEl.closest('header') ?? document).querySelector('nav')
        nav = navEl !== null ? (navEl.textContent || '').trim().slice(0, 40) : '(no nav)'
      }
      // Embed structure: enough to fix layout issues without guessing.
      var embedInfo = null
      try {
        if (embed.tablist !== null) {
          var hEl = embed.tablist.closest('header')
          var hostEl = embed.host
          if (hEl !== null && hostEl !== null) {
            var hcs = window.getComputedStyle(hostEl)
            var kids = []
            for (var k = 0; k < hostEl.children.length && kids.length < 8; k += 1) {
              var ch = hostEl.children[k]
              kids.push(`${ch.tagName}.${String(ch.className).slice(0, 30)}h${ch.offsetHeight}d${ch.style.display || '-'}`)
            }
            embedInfo = {
              header: `${hEl.tagName} h=${hEl.offsetHeight} inHost=${hEl.parentElement === hostEl}`,
              host: `${hostEl.tagName}.${String(hostEl.className).slice(0, 30)} disp=${hcs.display} pos=${hcs.position} ov=${hcs.overflow} cH=${hostEl.clientHeight} sH=${hostEl.scrollHeight}`,
              kids: kids,
              containerH: embed.container !== null ? embed.container.offsetHeight : null,
            }
          }
        }
      } catch (_) {}
      return {
        url: window.location.pathname.slice(0, 50),
        tablists: tablists,
        headers: document.querySelectorAll('header').length,
        navText: nav,
        hint: currentTitleHint().slice(0, 40),
        currentIsSsh: currentIsSsh,
        tabMounted: !!(embed.btn !== null && embed.btn.parentElement !== null),
        embedActive: embed.active,
        embedStruct: embedInfo,
        open: root.classList.contains('open'),
        embedded: root.classList.contains('embedded'),
        available: root.classList.contains('available'),
        sessions: sessionRows.length,
        activeFile: activeFile !== null ? String(activeFile).slice(-40) : null,
      }
    } catch (error) {
      return { diagError: String(error && error.message) }
    }
  }

  function postDiag() {
    if (document.visibilityState === 'hidden') return
    try {
      fetch('/ssh-remote-panel/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(collectDiag()),
      }).catch(function () {})
    } catch (_) {}
  }
  setTimeout(postDiag, 4000)
  setInterval(postDiag, 12000)

  refreshSessions().then(refreshJobs).catch(function () {})
})()
