# IPE Builder – extension Chrome (prototype v0.10)

## Installer l'extension dans Chrome (2 minutes)

1. Ouvre Chrome et tape `chrome://extensions` dans la barre d'adresse.
2. En haut à droite, active **Mode développeur**.
3. Clique sur **Charger l'extension non empaquetée** et sélectionne le dossier `Outil suivi des IPEs` (celui qui contient `manifest.json`).
4. Épingle l'extension (icône puzzle en haut à droite de Chrome, puis la punaise à côté de « IPE Builder »).
5. Clique sur l'icône : l'application s'ouvre dans un nouvel onglet.

Après une modification des fichiers, retourne sur `chrome://extensions` et clique sur la flèche circulaire de l'extension pour la recharger.

Pour installer une nouvelle version publiée sur GitHub, clique sur le bouton **Mettre à jour** sous le menu latéral (à partir de la v0.10, voir « Nouveautés v0.10 »).

## Récupérer les données du dashboard Smart Impulse

1. Ouvre une page **Analysis** du dashboard (énergie par mois, semaine ou jour, sur la période voulue, par ex. « All history »).
2. Clique sur l'icône de l'extension : les séries du graphique (usages en kWh, DJU chauffage et climatisation) sont lues, ainsi que les informations du site (pays, surface, horaires d'ouverture, coût moyen du kWh, intensité carbone), et l'application s'ouvre avec ces données.
3. Les périodes que les mesures ne couvrent pas entièrement (début d'instrumentation, mois en cours) sont exclues automatiquement. Tu peux aussi exclure une période à la main (case « Inclure » du tableau de données).

## Jours ouvrés, non ouvrés, heures d'ouverture

- Jours ouvrés : jours ouverts selon les horaires du site, hors jours fériés du pays (si la case est cochée).
- Jours non ouvrés : les autres jours de la période.
- Heures d'ouverture : somme des plages horaires des jours ouvrés (utile pour un site ouvert 7j/7 aux horaires variables).
- Jours calendaires : nombre total de jours de la période (ignoré par défaut).
- Jours fériés : bibliothèque date-holidays (207 pays, calculés pour n'importe quelle année, hors ligne). Niveau national uniquement : les fêtes locales (ex. saint patron d'une ville) ne sont pas prises en compte.

## Unités

Sélecteur « Unité » en haut : kWh, kWh/m², €, €/m², kgCO₂e, kgCO₂e/m². Les conversions utilisent la surface, le coût et l'intensité carbone du site, avec la valeur en vigueur à chaque période. Un IPE enregistré garde son unité.

## Utilisation

1. **Données** : données du dashboard, « Charger l'exemple », ou importer un CSV / coller un tableau Excel. Indiquer le rôle de chaque colonne (consommation, facteur d'influence, ignorer). Les jours ouvrés / non ouvrés / calendaires sont calculés automatiquement (jours fériés français inclus).
2. **Corrélations** : matrice des R² entre chaque consommation et toutes les variables ; clic sur une case pour voir le nuage de points et le graphique temporel lié (survoler un point surligne la période correspondante, et inversement). Clic sur un point ou une barre pour l'exclure / le réinclure ; filtre automatique des points au-delà de k × RMSE de la droite. Exclusions propres à chaque consommation, reprises dans l'onglet Modèle et mémorisées dans l'IPE enregistré.
   Période d'étude : listes déroulantes, longueur de fenêtre (en périodes), ou glisser la zone bleutée sur le graphique temporel (bords = redimensionner). Bouton « Utiliser dans Modèle & SER » : reprend la consommation, le facteur et la période.
3. **Modèle & SER** : même frise glissable pour la période de référence, avec les exclusions (clic pour exclure / réinclure ; le modèle se recalcule). Statistiques : t de Student signé, p-value, degrés de liberté, RMSE, t critique à 95 %, et contribution de chaque terme (constante × n, coefficient × somme du facteur) en part de la consommation de référence.
    choisir la période de référence, la consommation et les facteurs. « Tester toutes les combinaisons » classe les modèles par R² ajusté et indique ceux qui sont valides (|t| > 2 pour chaque facteur, CV(RMSE) et NMBE dans les seuils ASHRAE Guideline 14). Enregistrer l'IPE retenu.
4. **Suivi** : choisir un IPE enregistré et la période de suivi ; comparaison réel vs attendu, graphique des économies par période (kWh et %), économies cumulées, export CSV (format Excel français).

## Structure des fichiers

- `manifest.json` : carte d'identité de l'extension (nom, version, permissions)
- `background.js` : ouvre l'application quand on clique sur l'icône
- `app.html`, `css/app.css` : l'interface
- `js/stats.js` : moteur de calcul (régression, corrélations, jours ouvrés)
- `js/app.js` : logique de l'interface
- `js/sample.js` : jeu de données exemple
- `lib/chart.umd.js` : bibliothèque de graphiques Chart.js (licence MIT)
- `lib/holidays.js` : bibliothèque de jours fériés date-holidays (licence ISC, données CC-BY-SA 4.0, voir `lib/holidays-LICENSE.txt`)

Les IPE et les dernières données chargées sont conservés localement dans Chrome.

- `js/update.js` : bouton « Mettre à jour » (téléchargement depuis GitHub et écriture dans le dossier de l'extension)

- `js/extract.js` : lecture des données du graphique du dashboard (injectée dans la page au clic)

## Limite connue

La lecture s'appuie sur la façon dont le dashboard affiche son graphique (bibliothèque ECharts). Si l'équipe dashboard change cette structure, l'extension affichera un message d'erreur et `js/extract.js` sera à adapter.

## Nouveautés v0.5

- Couleurs des usages reprises du dashboard ; identifiant d'usage indépendant de la langue (un IPE créé sur « CVC » fonctionne si le dashboard passe en anglais « HVAC »). Exclusions conservées d'un import à l'autre pour le même site.
- Corrélations : matrice en haut ; variable X sur l'axe secondaire de la frise ; option « Ignorer les périodes où X = 0 » ; raccourcis de période (années, 52 dernières semaines / 12 derniers mois, tout).
- Modèle & SER : raccourcis de période ; filtre « Ignorer les périodes où [facteur] = 0 » (modèle valable seulement dans ce domaine) ; facteur sur l'axe secondaire ; critères de validation au choix (IPMVP, ISO 50001/50006 avec seuils SEP/EnPI Lite, ASHRAE Guideline 14) ; test F ; graphique de décomposition talon / part de chaque facteur.
- Suivi : tout l'historique avec période de référence (gris) et période de suivi glissable (bleu) ; raccourcis (années, juste après la référence, même période l'année suivante, depuis la fin de la référence) ; écart réel − attendu par période (vert #7BC622 = économie, orange #DF5327 = surconsommation) ; incertitude à 95 % et test IPMVP « économies > 2 × erreur type ».

## Conservation des IPE

Les IPE sont enregistrés dans le stockage local de Chrome et restent disponibles d'une semaine à l'autre (fermeture de Chrome, redémarrage, rechargement de l'extension). Ils sont perdus si l'extension est supprimée, ou si le dossier de l'extension est déplacé ou renommé (Chrome la considère alors comme une nouvelle extension). Garder le dossier au même endroit et exporter régulièrement les IPE en JSON (onglet Suivi) comme sauvegarde.

## Nouveautés v0.6

- Présentation alignée sur le dashboard Smart Impulse (bandeau turquoise, menu latéral, cartes arrondies, boutons pilule).
- Données : création de consommations combinées (somme de plusieurs usages, ex. chauffage + ventilation = CVC), recalculées à chaque import et conservées pour le même site.
- Modèle & SER : indicateurs réduits à R² (après filtres), RMSE, CV(RMSE), degrés de liberté et nombre de points ; tableau des termes : coefficient, erreur std, t de Student, contribution et part. Le test de toutes les combinaisons s'affiche sous les boutons et indique le nombre de combinaisons testées. Axe secondaire du graphique réel vs modélisé : « Facteur d'influence choisi ».

## Nouveautés v0.7

- Corrélations : axes du nuage de points à partir de (0, 0).
- Modèle & SER : seuils en couleur (R² ≥ 0,75, CV(RMSE) < 20 %, |t| > 2) ; indicateurs sur une ligne ; facteurs sur deux colonnes.
- Suivi : écart = réel − attendu partout (tableau, indicateurs, graphiques, export) ; économie ou surconsommation selon le signe ; suivi possible avant la référence (chaînage post → ante : un écart positif est alors une économie) ; raccourcis « juste avant la référence » et « même période, année précédente » ; référence en turquoise, suivi en vert.
- Aperçu : un seul axe vertical quand seules des variables du même type sont affichées.

## Nouveautés v0.8

- Facteurs non linéaires (Modèle & SER, encadré « Facteurs non linéaires ») :
  - Seuil max(0, X − s) : modèle à point de changement (talon puis pente au-delà du seuil). Le seuil s est recherché automatiquement (minimisation de l'erreur, avec les autres facteurs cochés), modifiable à la main ou réoptimisable (« Optimiser »). Il compte comme un paramètre estimé : un degré de liberté en moins.
  - Carré X² : ajouté avec X pour une courbe (ex. rendement de pompe à chaleur qui baisse par grand froid).
  - Ces facteurs apparaissent partout comme les autres (corrélations, combinaisons, décomposition, suivi). Option « Réoptimiser les seuils dans chaque combinaison » ; cliquer une ligne applique le seuil correspondant.
  - L'IPE enregistré fige la forme et le seuil : le suivi n'est pas modifié si le facteur est réglé ensuite. Le suivi signale les périodes dont les facteurs sortent de la plage de la référence (extrapolation).
- Barres des graphiques plus larges.

## Nouveautés v0.9

- Corrélations : choix de la forme de la régression à une variable (linéaire, seuil max(0, X − s) avec recherche du seuil, quadratique), tracée sur le nuage de points. Le filtre k × RMSE utilise la forme choisie. « Utiliser dans Modèle & SER » crée le facteur non linéaire correspondant (avec le seuil trouvé).
- Numéro de version affiché sous le menu latéral, pour vérifier que la mise à jour est bien chargée.

## Nouveautés v0.10

- Bouton « Mettre à jour » sous le menu latéral : installe la dernière version publiée sur GitHub (branche `main`) sans recharger l'extension à la main. Au premier clic, sélectionner le dossier de l'extension et autoriser Chrome à le modifier (choix mémorisé). Seuls les fichiers modifiés sont téléchargés et vérifiés, puis écrits après confirmation. L'extension se recharge ensuite et les IPE enregistrés sont conservés. Une pastille orange signale qu'une nouvelle version est disponible.
