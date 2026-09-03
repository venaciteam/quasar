// ═══════════════════════════════════════════════════════════════
//  Onglet « Anti-raid » — LOT C
//
//  PLACEHOLDER. L'onglet est enregistré dès maintenant pour que sa place et son
//  ordre dans la page soient figés : le lot qui livre ce module remplace le
//  contenu de ce fichier, sans toucher ni à automod.js, ni à app.html.
//
//  automod.js est chargé AVANT ce fichier dans app.html : c'est lui qui expose
//  registerAutomodTab.
// ═══════════════════════════════════════════════════════════════

registerAutomodTab({
    id: 'antiraid',
    label: 'Anti-raid',
    order: 30,
    render: async (container) => {
        container.innerHTML = `
            <div class="card">
                <div class="card-title">Anti-raid</div>
                <p style="color:var(--text-secondary);font-size:.9rem">
                    Détectez les arrivées massives sur une fenêtre de temps, refusez les comptes trop récents, et basculez le serveur en mode panique.
                </p>
                <p style="color:var(--text-muted);font-size:.8rem;margin-top:.5rem">
                    Ce module arrive dans une prochaine mise à jour.
                </p>
            </div>
        `;
    },
});
