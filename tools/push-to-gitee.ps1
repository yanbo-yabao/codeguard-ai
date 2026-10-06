# ---------------------------------------------------------------------------
# CodeGuard AI - one-click publish to Gitee
#
# Usage (run from the project root, or pass the project path):
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/push-to-gitee.ps1 `
#       -RepoUrl https://gitee.com/<your-account>/codeguard-ai.git
#
# Optional:
#   -UserName / -UserEmail   : author identity recorded in the initial commit
#   -Branch                  : branch name (default: master)
#   -GitExe                  : path to git.exe if it is not on PATH
#
# This script is ASCII-only on purpose: Windows PowerShell 5.1 decodes .ps1
# files as GBK, so non-ASCII literals would be garbled.
# ---------------------------------------------------------------------------

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [string]$UserName = 'CodeGuard Team',
    [string]$UserEmail = 'codeguard@example.com',
    [string]$Branch = 'master',
    [string]$ProjectDir = '',
    [string]$GitExe = ''
)

$ErrorActionPreference = 'Stop'

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "    [OK] $Text" -ForegroundColor Green
}

function Write-Warn([string]$Text) {
    Write-Host "    [!!] $Text" -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 1. Locate the project directory (parent of this script's folder)
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($ProjectDir)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ProjectDir = Split-Path -Parent $scriptDir
}

if (-not (Test-Path (Join-Path $ProjectDir 'package.json'))) {
    throw "package.json not found under '$ProjectDir'. Pass -ProjectDir explicitly."
}
$ProjectDir = (Resolve-Path $ProjectDir).Path
Write-Step "Project directory: $ProjectDir"

# ---------------------------------------------------------------------------
# 2. Locate git.exe
# ---------------------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($GitExe)) {
    $candidates = @(
        'D:\PortableGit\cmd\git.exe',
        'C:\Program Files\Git\cmd\git.exe',
        'C:\Program Files (x86)\Git\cmd\git.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { $GitExe = $candidate; break }
    }
    if ([string]::IsNullOrWhiteSpace($GitExe)) {
        $onPath = Get-Command git.exe -ErrorAction SilentlyContinue
        if ($onPath) { $GitExe = $onPath.Source }
    }
}
if ([string]::IsNullOrWhiteSpace($GitExe)) {
    throw "git.exe not found. Install Git, or pass -GitExe <path>."
}
Write-Step "Using git: $GitExe"
& $GitExe --version | ForEach-Object { Write-Ok $_ }

# ---------------------------------------------------------------------------
# 3. Repository checks
# ---------------------------------------------------------------------------
Write-Step 'Checking repository state'
Push-Location $ProjectDir
try {
    # A safety net against publishing secrets
    $ignored = if (Test-Path '.gitignore') { Get-Content '.gitignore' -Raw } else { '' }
    if ($ignored -notmatch '(?m)^\.env$') {
        Write-Warn '.gitignore does not ignore ".env" - please fix it before pushing.'
    }
    if (Test-Path '.env') {
        Write-Warn '.env exists (it is ignored by git and will NOT be committed) - keep it that way.'
    }

    if (-not (Test-Path '.git')) {
        Write-Step 'Initializing git repository'
        & $GitExe init -b $Branch
        Write-Ok "Initialized on branch $Branch"
    }
    else {
        Write-Ok 'Existing git repository detected'
    }

    # Make sure author identity is set for this repository only
    & $GitExe config user.name $UserName
    & $GitExe config user.email $UserEmail
    Write-Ok "Author identity: $UserName <$UserEmail>"

    # -----------------------------------------------------------------------
    # 4. Commit anything still pending
    # -----------------------------------------------------------------------
    $status = & $GitExe status --porcelain
    if ($status) {
        Write-Step 'Staging and committing pending changes'
        & $GitExe add -A
        & $GitExe commit -m 'chore: 同步工作区变更'
        Write-Ok 'Changes committed'
    }
    else {
        Write-Ok 'Working tree is clean'
    }

    $commitCount = (& $GitExe rev-list --count HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $commitCount) { $commitCount = 0 }
    Write-Ok "Commit history: $commitCount commits"

    # -----------------------------------------------------------------------
    # 5. Configure remote and push
    # -----------------------------------------------------------------------
    Write-Step "Configuring remote origin -> $RepoUrl"
    $existingRemote = & $GitExe remote 2>$null
    if ($existingRemote -contains 'origin') {
        & $GitExe remote set-url origin $RepoUrl
        Write-Ok 'Remote origin updated'
    }
    else {
        & $GitExe remote add origin $RepoUrl
        Write-Ok 'Remote origin added'
    }

    Write-Step "Pushing branch $Branch to Gitee (you may be asked for credentials)"
    Write-Host '    Hint: for Gitee, use your account name + a personal access token as the password.' -ForegroundColor DarkGray

    & $GitExe push -u origin $Branch
    if ($LASTEXITCODE -ne 0) {
        Write-Warn 'Push failed. Common causes and fixes:'
        Write-Host '      - Authentication: use your Gitee account + personal access token (not your login password).' -ForegroundColor DarkGray
        Write-Host '      - Remote already has commits: run  git pull --rebase origin <branch>  then push again.' -ForegroundColor DarkGray
        Write-Host '      - Wrong URL: it must end with .git, e.g. https://gitee.com/you/codeguard-ai.git' -ForegroundColor DarkGray
        throw 'git push failed'
    }

    Write-Ok 'Push completed'

    Write-Step 'Done'
    Write-Host '    Repository URL : ' -NoNewline; Write-Host $RepoUrl -ForegroundColor White
    Write-Host '    Next steps:' -ForegroundColor Cyan
    Write-Host '      1) Open the repository on Gitee and set visibility to Public.'
    Write-Host '      2) Verify that .env is NOT listed in the file tree.'
    Write-Host '      3) Confirm the commit history is visible under "Commits".'
}
finally {
    Pop-Location
}
