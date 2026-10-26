<#
    Keeps the version in CMakeLists.txt in step with the work.

    project(PepperStitch VERSION x.y.z ...) is the only place the version is
    written.  CMake derives the executable's name, its version resource and
    version_generated.h from it, so bumping here is enough for the tag, the
    release asset and the running app to agree.

    Modes:
      auto    bump PATCH when a source file is newer than the last build,
              otherwise leave the version alone
      bump    always bump PATCH
      same    leave the version alone
      set     take -Version x.y.z
      stamp   record that the current sources have been built

    Prints the version the build should carry.
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('auto', 'bump', 'same', 'set', 'stamp')]
    [string]$Mode,

    [string]$Version,

    [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$cmake = Join-Path $Root 'CMakeLists.txt'
$stamp = Join-Path $Root 'build\.ps-version-stamp'
$pattern = '(?m)^project\(PepperStitch VERSION (\d+\.\d+\.\d+)'

$text = [System.IO.File]::ReadAllText($cmake)
$match = [regex]::Match($text, $pattern)
if (-not $match.Success) {
    throw "project(PepperStitch VERSION ...) not found in $cmake"
}
$current = $match.Groups[1].Value

# The sources that end up inside the executable.  build.bat and tools/ are not
# among them: changing how the app is built does not change what it is.
function Test-SourcesChanged {
    if (-not (Test-Path $stamp)) { return $true }
    $built = (Get-Item $stamp).LastWriteTimeUtc
    foreach ($relative in @('src', 'assets', 'CMakeLists.txt')) {
        $full = Join-Path $Root $relative
        if (-not (Test-Path $full)) { continue }
        $item = Get-Item $full
        if ($item.PSIsContainer) {
            $newer = Get-ChildItem $full -Recurse -File -Force |
                Where-Object { $_.LastWriteTimeUtc -gt $built } |
                Select-Object -First 1
            if ($newer) { return $true }
        } elseif ($item.LastWriteTimeUtc -gt $built) {
            return $true
        }
    }
    return $false
}

function Set-Version([string]$value) {
    $replacement = 'project(PepperStitch VERSION ' + $value
    $updated = [regex]::Replace($text, $pattern, $replacement)
    [System.IO.File]::WriteAllText($cmake, $updated, (New-Object System.Text.UTF8Encoding($false)))
    $script:text = $updated
    $script:current = $value
}

switch ($Mode) {
    'stamp' {
        $folder = Split-Path -Parent $stamp
        if (-not (Test-Path $folder)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
        [System.IO.File]::WriteAllText($stamp, $current)
        break
    }
    'same' { break }
    'set' {
        if ($Version -notmatch '^\d+\.\d+\.\d+$') {
            throw "-Version must look like 1.2.3"
        }
        if ($Version -ne $current) { Set-Version $Version }
        break
    }
    'bump' {
        $parts = $current.Split('.')
        $parts[2] = [string]([int]$parts[2] + 1)
        Set-Version ($parts -join '.')
        break
    }
    'auto' {
        if (Test-SourcesChanged) {
            $parts = $current.Split('.')
            $parts[2] = [string]([int]$parts[2] + 1)
            Set-Version ($parts -join '.')
        }
        break
    }
}

Write-Output $current
