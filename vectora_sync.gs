// ============================================================
// VECTORA > GitHub Sync
// File: vectora_sync.gs
//
// Syncs current VECTORA source to github.com/taktikz/gdis
// using the GitHub Git Data API (atomic multi-file commit).
//
// SETUP (one-time):
//   1. Extensions > Apps Script > Project Settings > Script Properties
//   2. Add property: GITHUB_TOKEN  → your PAT (repo scope required)
//   3. Optionally:  GITHUB_BRANCH → target branch (default: main)
//
// USAGE:
//   1. Run diagnoseSyncSetup() first — read-only, safe to run anytime
//   2. Run syncVectoraToGithub() to commit current source to GitHub
// ============================================================

// Global constants — safe (no logic, no side effects)
var VX_SYNC_GH_OWNER  = 'taktikz';
var VX_SYNC_GH_REPO   = 'gdis';
var VX_SYNC_GH_DIR    = 'src';

// @task
function diagnoseSyncSetup() {
  Logger.log('=== VECTORA GitHub Sync — Diagnostic ===');

  // 1. Script Properties
  var props    = PropertiesService.getScriptProperties();
  var ghToken  = props.getProperty('GITHUB_TOKEN');
  var branch   = props.getProperty('GITHUB_BRANCH') || 'main';

  Logger.log('GITHUB_TOKEN : ' + (ghToken ? '✅ set (' + ghToken.length + ' chars)' : '❌ NOT SET'));
  Logger.log('GITHUB_BRANCH: ' + branch);

  if (!ghToken) {
    Logger.log('\n→ Add GITHUB_TOKEN via Project Settings > Script Properties, then re-run.');
    return;
  }

  // 2. GitHub repo access
  var repo = _vxSync_ghGet_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO);
  if (!repo || !repo.name) {
    Logger.log('❌ Repo access failed. Verify token has "repo" (or "contents: write") scope.');
    return;
  }
  Logger.log('Repo access  : ✅ ' + repo.full_name + ' (' + (repo.private ? 'private' : 'public') + ')');

  // 3. Branch exists
  var ref = _vxSync_ghGet_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + '/git/refs/heads/' + branch);
  if (!ref || !ref.object) {
    Logger.log('❌ Branch "' + branch + '" not found. Set GITHUB_BRANCH in Script Properties or create the branch.');
    return;
  }
  Logger.log('Branch HEAD  : ✅ ' + branch + ' @ ' + ref.object.sha.slice(0, 7));

  // 4. Apps Script API — fetch own source
  var scriptId    = ScriptApp.getScriptId();
  var oauthToken  = ScriptApp.getOAuthToken();
  Logger.log('Script ID    : ' + scriptId);

  var files = _vxSync_fetchScriptFiles_(scriptId, oauthToken);
  if (!files) {
    Logger.log('❌ Could not read script source. Ensure script.projects.readonly scope is authorised.');
    return;
  }

  Logger.log('Source files : ✅ ' + files.length + ' files');
  files.forEach(function(f) {
    var ext = f.type === 'SERVER_JS' ? '.gs' : f.type === 'HTML' ? '.html' : f.type === 'JSON' ? '.json' : '';
    Logger.log('  ' + VX_SYNC_GH_DIR + '/' + f.name + ext + '  (' + (f.source ? f.source.length : 0) + ' chars)');
  });

  Logger.log('\n✅ All checks passed — ready to run syncVectoraToGithub()');
}

// @task
function syncVectoraToGithub() {
  Logger.log('=== VECTORA > GitHub Sync ===');

  var props    = PropertiesService.getScriptProperties();
  var ghToken  = props.getProperty('GITHUB_TOKEN');
  if (!ghToken) {
    Logger.log('❌ GITHUB_TOKEN not set. Run diagnoseSyncSetup() for setup instructions.');
    return;
  }

  var branch = props.getProperty('GITHUB_BRANCH') || 'main';
  Logger.log('Target: ' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + ' @ ' + branch);

  // 1. Fetch current script source via Apps Script API
  var scriptId   = ScriptApp.getScriptId();
  var oauthToken = ScriptApp.getOAuthToken();
  var files      = _vxSync_fetchScriptFiles_(scriptId, oauthToken);
  if (!files) { Logger.log('❌ Aborting — could not fetch script source.'); return; }
  Logger.log('Fetched ' + files.length + ' source files.');

  // 2. Build path → content map
  var fileMap = {};
  files.forEach(function(file) {
    var ext = file.type === 'SERVER_JS' ? '.gs'
            : file.type === 'HTML'      ? '.html'
            : file.type === 'JSON'      ? '.json'
            : null;
    if (!ext || file.source == null) return;
    fileMap[VX_SYNC_GH_DIR + '/' + file.name + ext] = file.source;
  });

  var paths      = Object.keys(fileMap);
  var fileCount  = paths.length;
  Logger.log('Preparing to commit ' + fileCount + ' files to ' + VX_SYNC_GH_DIR + '/');
  if (fileCount === 0) { Logger.log('❌ No files to commit.'); return; }

  // 3. Get branch HEAD commit SHA
  var ref = _vxSync_ghGet_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + '/git/refs/heads/' + branch);
  if (!ref || !ref.object) { Logger.log('❌ Could not get branch ref.'); return; }
  var latestCommitSha = ref.object.sha;

  // 4. Get base tree SHA from HEAD commit
  var headCommit = _vxSync_ghGet_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + '/git/commits/' + latestCommitSha);
  if (!headCommit || !headCommit.tree) { Logger.log('❌ Could not get HEAD commit tree.'); return; }
  var baseTreeSha = headCommit.tree.sha;

  // 5. Create blobs for each file
  var treeItems = [];
  for (var i = 0; i < paths.length; i++) {
    var path    = paths[i];
    var content = fileMap[path];
    var blob    = _vxSync_ghPost_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + '/git/blobs', {
      content:  content,
      encoding: 'utf-8'
    });
    if (!blob || !blob.sha) { Logger.log('❌ Failed to create blob for: ' + path); return; }
    treeItems.push({ path: path, mode: '100644', type: 'blob', sha: blob.sha });
    Logger.log('  blob ✓ ' + path);
  }

  // 6. Create new tree on top of base
  var newTree = _vxSync_ghPost_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + '/git/trees', {
    base_tree: baseTreeSha,
    tree:      treeItems
  });
  if (!newTree || !newTree.sha) { Logger.log('❌ Failed to create tree.'); return; }

  // 7. Create commit
  var timestamp = new Date().toISOString();
  var newCommit = _vxSync_ghPost_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + '/git/commits', {
    message: 'sync: VECTORA source ' + timestamp,
    tree:    newTree.sha,
    parents: [latestCommitSha]
  });
  if (!newCommit || !newCommit.sha) { Logger.log('❌ Failed to create commit.'); return; }

  // 8. Advance branch ref to new commit
  var updated = _vxSync_ghPatch_(ghToken, '/repos/' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + '/git/refs/heads/' + branch, {
    sha: newCommit.sha
  });
  if (!updated || !updated.object) { Logger.log('❌ Failed to update branch ref.'); return; }

  Logger.log('');
  Logger.log('✅ Synced ' + fileCount + ' files to ' + VX_SYNC_GH_OWNER + '/' + VX_SYNC_GH_REPO + ' @ ' + branch);
  Logger.log('🔗 ' + (newCommit.html_url || newCommit.sha));
}

// ---- Internal helpers ----

function _vxSync_fetchScriptFiles_(scriptId, oauthToken) {
  var url  = 'https://script.googleapis.com/v1/projects/' + scriptId + '/content';
  var resp = UrlFetchApp.fetch(url, {
    method:              'get',
    headers:             { Authorization: 'Bearer ' + oauthToken },
    muteHttpExceptions:  true
  });
  if (resp.getResponseCode() !== 200) {
    Logger.log('Apps Script API error ' + resp.getResponseCode() + ': ' + resp.getContentText());
    return null;
  }
  var data = JSON.parse(resp.getContentText());
  return data.files || null;
}

function _vxSync_ghGet_(token, path) {
  var resp = UrlFetchApp.fetch('https://api.github.com' + path, {
    method:             'get',
    headers:            _vxSync_ghHeaders_(token),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) {
    Logger.log('GitHub GET ' + path + ' → ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
    return null;
  }
  return JSON.parse(resp.getContentText());
}

function _vxSync_ghPost_(token, path, body) {
  var resp = UrlFetchApp.fetch('https://api.github.com' + path, {
    method:             'post',
    headers:            _vxSync_ghHeaders_(token),
    payload:            JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) {
    Logger.log('GitHub POST ' + path + ' → ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
    return null;
  }
  return JSON.parse(resp.getContentText());
}

function _vxSync_ghPatch_(token, path, body) {
  var resp = UrlFetchApp.fetch('https://api.github.com' + path, {
    method:             'patch',
    headers:            _vxSync_ghHeaders_(token),
    payload:            JSON.stringify(body),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 400) {
    Logger.log('GitHub PATCH ' + path + ' → ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
    return null;
  }
  return JSON.parse(resp.getContentText());
}

function _vxSync_ghHeaders_(token) {
  return {
    Authorization:        'Bearer ' + token,
    Accept:               'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':       'application/json'
  };
}
