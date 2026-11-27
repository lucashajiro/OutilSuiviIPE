# IPE Builder – Smart Impulse

Extension Chrome pour **construire et suivre des Indicateurs de Performance Énergétique (IPE)** à partir des données du dashboard Smart Impulse ou d'un fichier CSV : corrélations, modèle de régression (situation énergétique de référence, SER), puis suivi réel vs attendu et calcul des économies.

Version actuelle : **0.10.1** (prototype). Tout fonctionne hors ligne, dans le navigateur, et aucune donnée n'est envoyée à un serveur. Seul le bouton de mise à jour contacte GitHub, pour télécharger le code.

## Installation

1. Cloner ou télécharger ce dépôt.
2. Dans Chrome, ouvrir `chrome://extensions` et activer le **Mode développeur** (en haut à droite).
3. Cliquer sur **Charger l'extension non empaquetée** et choisir le dossier [`Outil suivi des IPEs/`](Outil%20suivi%20des%20IPEs/) (celui qui contient `manifest.json`).
4. Épingler l'extension « IPE Builder » dans la barre d'outils.

### Mettre à jour

À partir de la v0.10, le bouton **Mettre à jour** (sous le menu latéral) installe la dernière version publiée sur la branche `main` de ce dépôt, sans recharger l'extension à la main. Une pastille orange signale qu'une nouvelle version est disponible.

1. Au premier clic, sélectionner le dossier `Outil suivi des IPEs` et autoriser Chrome à le modifier. Ce choix est mémorisé, mais Chrome peut redemander l'autorisation d'une session à l'autre.
2. Le bouton compare chaque fichier local à GitHub, télécharge et vérifie les fichiers modifiés, puis demande confirmation avant d'écrire.
3. L'extension se recharge et l'application se rouvre. Les IPE enregistrés sont conservés.

Le dépôt doit être **public**, car le bouton télécharge les fichiers sans authentification. Les fichiers supprimés du dépôt ne sont pas supprimés localement, ce qui ne pose pas de problème. Pour publier une version, pousser sur `main` en augmentant `version` dans `manifest.json` : c'est ce numéro qui allume la pastille.

Pour passer de la v0.9 (sans bouton) à la v0.10, il faut faire la mise à jour une fois à la main : remplacer les fichiers du dossier, puis recharger l'extension.

### Pendant le développement

Après une modification du code, cliquer sur la flèche circulaire de l'extension dans `chrome://extensions` pour la recharger. Le numéro de version affiché sous le menu latéral permet de vérifier que la bonne version est chargée.

> **Attention :** les IPE sont enregistrés dans le stockage local de Chrome, rattaché à l'extension. Ils sont perdus si l'extension est supprimée ou si son dossier est déplacé ou renommé. Exporter régulièrement les IPE en JSON (onglet **Suivi**).

## Démarrage rapide

- **Depuis le dashboard** : ouvrir une page *Analysis* sur `dashboard.smart-impulse.com` (énergie par mois, semaine ou jour), puis cliquer sur l'icône de l'extension. Les usages (kWh), les DJU et les informations du site (pays, surface, horaires, coût du kWh, intensité carbone) sont lus et l'application s'ouvre avec ces données.
- **Ailleurs** : un clic sur l'icône ouvre l'application vide. On peut alors cliquer sur **Charger l'exemple**, importer un CSV ou coller un tableau Excel.

### Format CSV / tableau collé

- Une ligne d'en-tête. Séparateur `;`, `,` ou tabulation (détecté automatiquement).
- **Première colonne = date** : `AAAA-MM-JJ`, `JJ/MM/AAAA`, `MM/AAAA` ou `AAAA-MM`.
- Colonnes suivantes : valeurs numériques. La virgule décimale est acceptée.
- La granularité (jour, semaine ou mois) est déduite de l'écart entre les dates. Le rôle de chaque colonne (consommation, facteur d'influence, ignorer) est proposé d'après son nom et peut être modifié.

```csv
Date;Chauffage;Éclairage;DJU chauffage
2024-01-01;12500;3400;380
2024-02-01;10800;3100;320
```

## Parcours dans l'application

| Onglet | Rôle |
|---|---|
| **Données** | Import, rôle des colonnes, exclusion de périodes, consommations combinées (ex. chauffage + ventilation = CVC). Les jours ouvrés, non ouvrés et calendaires et les heures d'ouverture sont calculés automatiquement, jours fériés du pays compris. |
| **Corrélations** | Matrice des R² entre consommations et variables. Nuage de points lié au graphique temporel, régression linéaire, à seuil ou quadratique, exclusion de points, filtre k × RMSE. |
| **Modèle & SER** | Régression multiple sur la période de référence, avec t de Student, p-value, RMSE, CV(RMSE), NMBE et test F. Facteurs non linéaires (seuil `max(0, X − s)` et `X²`). Test de toutes les combinaisons. Validation selon IPMVP, ISO 50001/50006 ou ASHRAE Guideline 14. Enregistrement de l'IPE. |
| **Suivi** | Comparaison réel vs attendu sur une période de suivi, économies par période et cumulées, incertitude à 95 %, alerte d'extrapolation. Export CSV (format Excel français) et export/import des IPE en JSON. |

Unités disponibles : kWh, kWh/m², €, €/m², kgCO₂e, kgCO₂e/m².

## Structure du code

Tout le code est dans [`Outil suivi des IPEs/`](Outil%20suivi%20des%20IPEs/). C'est du JavaScript sans étape de build ni dépendance npm.

| Fichier | Contenu |
|---|---|
| `manifest.json` | Manifeste Chrome (MV3) : nom, version, permissions (`storage`, `activeTab`, `scripting`, accès à GitHub pour la mise à jour) |
| `background.js` | Service worker. Au clic sur l'icône, injecte l'extracteur sur le dashboard puis ouvre `app.html` |
| `js/extract.js` | Lecture des séries du graphique ECharts du dashboard (exécutée dans la page) |
| `app.html`, `css/app.css` | Interface |
| `js/app.js` | Logique de l'interface (import, onglets, graphiques, stockage) |
| `js/stats.js` | Moteur de calcul : régressions, corrélations, statistiques, jours ouvrés |
| `js/sample.js` | Jeu de données d'exemple |
| `js/update.js` | Bouton « Mettre à jour » : téléchargement depuis GitHub et écriture dans le dossier de l'extension |
| `lib/chart.umd.js` | [Chart.js](https://www.chartjs.org/) (MIT) |
| `lib/holidays.js` | [date-holidays](https://github.com/commenthol/date-holidays) (ISC, données CC-BY-SA 4.0, voir `lib/holidays-LICENSE.txt`) |

## Limites connues

- L'extraction dépend de la structure du graphique ECharts du dashboard. Si celle-ci change, l'extension affiche une erreur et `js/extract.js` doit être adapté.
- Jours fériés : niveau national uniquement. Les fêtes locales ne sont pas prises en compte.

## Documentation détaillée

Le guide utilisateur complet et l'historique des versions sont dans [`Outil suivi des IPEs/LISEZMOI.md`](Outil%20suivi%20des%20IPEs/LISEZMOI.md).
