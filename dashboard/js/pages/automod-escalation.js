// ═══════════════════════════════════════════════════════════════
//  Onglet « Escalade » — LOT B
//
//  PLACEHOLDER. L'onglet est enregistré dès maintenant pour que sa place et son
//  ordre dans la page soient figés : le lot qui livre ce module remplace le
//  contenu de ce fichier, sans toucher ni à automod.js, ni à app.html.
//
//  automod.js est chargé AVANT ce fichier dans app.html : c'est lui qui expose
//  registerAutomodTab.
// ═══════════════════════════════════════════════════════════════

registerAutomodTab({
    id: 'escalation',
    label: 'Escalade',
    order: 20,
    render: async (container) => {
        container.innerHTML = `
            <div class="card">
                <div class="card-title">Escalade</div>
                <p style="color:var(--text-secondary);font-size:.9rem">
                    Déclenchez automatiquement une sanction quand un membre atteint un nombre d'avertissements que vous fixez.
                </p>
                <p style="color:var(--text-muted);font-size:.8rem;margin-top:.5rem">
                    Ce module arrive dans une prochaine mise à jour.
                </p>
            </div>
        `;
    },
});
