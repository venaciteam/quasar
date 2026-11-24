# Image de partage

`public/og-image.jpg` (1200 × 630) est l'image que montrent Discord, les réseaux et les messageries quand on partage un lien vers la vitrine. Elle se refait en trois temps, depuis la racine du dépôt.

1. Lancer le dashboard de démonstration (données inventées, animations coupées) :

   ```bash
   node scripts/og/dashboard-demo.mjs
   ```

2. Capturer le dashboard en thème sombre (2880 × 1800), puis rendre le gabarit `og.html` :

   ```bash
   chrome --headless=new --hide-scrollbars --force-dark-mode --user-data-dir="$TMPDIR/og-a" --force-device-scale-factor=2 --window-size=1440,900 --virtual-time-budget=6000 --screenshot="$PWD/scripts/og/dashboard.png" "http://127.0.0.1:4789/dashboard/app.html?token=demo"
   chrome --headless=new --hide-scrollbars --allow-file-access-from-files --user-data-dir="$TMPDIR/og-b" --force-device-scale-factor=1 --window-size=1200,630 --virtual-time-budget=3000 --screenshot="$PWD/og.png" "file://$PWD/scripts/og/og.html"
   ```

   Sous Windows, `chrome` est `"C:/Program Files/Google/Chrome/Application/chrome.exe"` et les chemins passés à Chrome doivent être des chemins Windows (`cygpath -m` sous Git Bash).

3. Convertir en JPEG (les messageries ignorent les aperçus trop lourds) :

   ```bash
   python -c "from PIL import Image; Image.open('og.png').convert('RGB').save('public/og-image.jpg', quality=86, optimize=True, progressive=True)" && rm og.png
   ```

Les pages de `public/` y renvoient avec `?v=__VERSION__` : une nouvelle version suffit à faire relire l'image aux caches.
