# Throwaway static file server for testing the front end in a browser.
#   powershell -File tools\dev-server.ps1 -Root <folder> [-Port 8123]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [int]$Port = 8123
)

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Serving $Root on http://127.0.0.1:$Port/"

$contentTypes = @{
    '.html' = 'text/html; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.json' = 'application/json'
    '.png'  = 'image/png'
    '.jpg'  = 'image/jpeg'
    '.jpeg' = 'image/jpeg'
    '.webp' = 'image/webp'
    '.svg'  = 'image/svg+xml'
    '.ico'  = 'image/x-icon'
}

while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
        $stream = $client.GetStream()
        $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)
        $requestLine = $reader.ReadLine()

        # headers, ignored apart from draining them
        while ($true) {
            $line = $reader.ReadLine()
            if ([string]::IsNullOrEmpty($line)) { break }
        }

        $path = '/'
        if ($requestLine -match '^[A-Z]+\s+(\S+)') {
            $path = $matches[1].Split('?')[0]
            if ($path -eq '/') { $path = '/index.html' }
            $path = [System.Uri]::UnescapeDataString($path).Replace('/', '\')
        }

        $full = [System.IO.Path]::GetFullPath((Join-Path $Root $path.TrimStart('\')))
        $rootFull = [System.IO.Path]::GetFullPath($Root)
        $status = '200 OK'
        $body = $null
        $type = 'application/octet-stream'

        if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
            -not (Test-Path -LiteralPath $full -PathType Leaf)) {
            $status = '404 Not Found'
            $body = [System.Text.Encoding]::UTF8.GetBytes('not found')
            $type = 'text/plain'
        } else {
            $body = [System.IO.File]::ReadAllBytes($full)
            $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
            if ($contentTypes.ContainsKey($ext)) { $type = $contentTypes[$ext] }
        }

        $head = "HTTP/1.1 $status`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
        $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
        $stream.Write($headBytes, 0, $headBytes.Length)
        $stream.Write($body, 0, $body.Length)
        $stream.Flush()
    } catch {
        # a dropped connection is normal here
    } finally {
        $client.Close()
    }
}
