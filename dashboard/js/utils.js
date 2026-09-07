/**
 * Échappement HTML — implémentation UNIQUE du dashboard.
 *
 * Quatre copies coexistaient (ici, app.js, tempvoice.js, tickets.js), dont
 * trois fabriquées par sérialisation `textContent` → `innerHTML` : ce procédé
 * n'échappe NI `"` NI `'`. En contexte texte il suffit, en contexte d'attribut
 * (`value="${…}"`) il laisse sortir de l'attribut. La seule chose qui empêchait
 * l'XSS était l'ordre des balises <script> de app.html, app.js — porteur de la
 * seule version robuste — étant chargé en dernier : ajouter un `defer` ou
 * réordonner le HTML aurait rendu une douzaine de contextes d'attribut
 * injectables, en silence.
 *
 * D'où cette règle : une seule définition, dans le premier fichier chargé, et
 * plus aucune variante ailleurs. Le jeton de session vit dans localStorage et
 * reste valable 7 jours sans révocation possible — un XSS ici, c'est une
 * session d'administrateur·ice volée. test/dashboard-escape.test.js interdit la
 * réapparition d'une implémentation faible.
 *
 * `null` et `undefined` rendent une chaîne vide (et non « null »), les autres
 * valeurs passent par String() : un nombre reste affiché.
 */
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

/**
 * Convertit les emojis Discord custom (<:name:id> ou <a:name:id>) en images
 *
 * Le retour part directement dans `innerHTML` (panels de reaction roles), et
 * l'emoji d'un panel n'est validé nulle part côté serveur : la valeur de repli
 * était rendue telle quelle, donc `<img src=x onerror=…>` enregistré comme
 * « emoji » s'exécutait au simple affichage de la page. Elle est désormais
 * échappée. Le cas custom, lui, ne peut rien injecter : `\w+` et `\d+`
 * n'admettent ni guillemet ni chevron.
 */
function renderEmoji(emojiStr) {
    const str = String(emojiStr ?? '');
    // Custom emoji : <:name:id> ou <a:name:id>
    const customMatch = str.match(/^<(a)?:(\w+):(\d+)>$/);
    if (customMatch) {
        const animated = customMatch[1] === 'a';
        const name = customMatch[2];
        const id = customMatch[3];
        const ext = animated ? 'gif' : 'png';
        return `<img src="https://cdn.discordapp.com/emojis/${id}.${ext}" alt="${name}" title=":${name}:" style="width:1.2em;height:1.2em;vertical-align:middle;object-fit:contain">`;
    }
    // Emoji Unicode — ou n'importe quoi d'autre : c'est du texte, pas du HTML.
    return escapeHtml(str);
}

/**
 * Debounce un bouton : désactive pendant l'exécution de fn, puis réactive
 */
function withDebounce(btn, fn) {
    if (btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    Promise.resolve(fn()).finally(() => {
        btn.disabled = false;
        btn.textContent = original;
    });
}

window.renderEmoji = renderEmoji;
window.escapeHtml = escapeHtml;
window.withDebounce = withDebounce;
