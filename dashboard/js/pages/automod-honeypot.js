// ═══════════════════════════════════════════════════════════════
//  Onglet « Honeypot et arbitrage » — LOT D
//
//  PLACEHOLDER. L'onglet est enregistré dès maintenant pour que sa place et son
//  ordre dans la page soient figés : le lot qui livre ce module remplace le
//  contenu de ce fichier, sans toucher ni à automod.js, ni à app.html.
//
//  automod.js est chargé AVANT ce fichier dans app.html : c'est lui qui expose
//  registerAutomodTab.
// ═══════════════════════════════════════════════════════════════

registerAutomodTab({
    id: 'honeypot',
    label: 'Honeypot et arbitrage',
    order: 40,
    render: async (container) => {
        container.innerHTML = `
            <div class="card">
                <div class="card-title">Honeypot et arbitrage</div>
                <p style="color:var(--text-secondary);font-size:.9rem">
                    Désignez un salon piège que personne ne devrait utiliser, et un salon d'arbitrage où votre équipe tranche les cas au lieu de laisser la sanction tomber seule.
                </p>
                <p style="color:var(--text-muted);font-size:.8rem;margin-top:.5rem">
                    Ce module arrive dans une prochaine mise à jour.
                </p>
            </div>
        `;
    },
});
