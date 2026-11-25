/**
 * Génère un bloc HTML "Commandes disponibles" pour une page de module.
 *
 * ⚠️ Les libellés sont écrits avec une barre oblique (« /warn @membre »), parce
 * que c'est la forme de la plateforme historique. `reecrireCommandes` les
 * traduit dans la forme de la plateforme ACTIVE : sur une plateforme sans
 * commandes d'application, l'aide doit afficher le préfixe réel, sans quoi elle
 * enseigne une syntaxe qui ne répond pas. Côté Discord, la chaîne ressort à
 * l'identique — c'est la condition de non-régression.
 */
function renderCommandsBlock(commands) {
    const ecrire = (texte) => QuasarPlateforme.reecrireCommandes(texte);
    return `
        <div class="card" style="margin-top:1.5rem">
            <div class="card-title">💬 Commandes disponibles</div>
            <div class="commands-grid" style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:.75rem">
                ${commands.map(([cmd, desc]) => `
                    <div style="padding:.6rem .9rem;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-sm)">
                        <code style="color:var(--accent);font-size:.85rem">${ecrire(cmd)}</code>
                        <p style="color:var(--text-secondary);font-size:.8rem;margin-top:.2rem">${ecrire(desc)}</p>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

window.renderCommandsBlock = renderCommandsBlock;
