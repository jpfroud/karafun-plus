# TODOS

Travail reporté par les relectures de plan (gstack `autoplan`), avec son contexte. Les décisions viennent de `docs/designs/retours-2026-11-08.md`.

## Statistiques

### Découper ou rattacher une soirée à la main dans /stats

**What:** Dans la page des statistiques, « Séparer la soirée ici » et « Rattacher à la soirée précédente ».

**Why:** La réparation automatique ne coupe qu'aux frontières de 8 h du matin. Deux soirées le même jour, ou un après-midi privatisé suivi d'une soirée, restent dans un seul journal.

**Context:** Proposé et reporté par la relecture du 9 novembre 2026 (X4). La réparation automatique (`EveningJournal.repair`, lot A4 du plan) garde l'original dans `data/soirees-originales/` ; un outil manuel devra réutiliser ce découpage (lignes reportées, identifiants déterministes, écritures `.tmp` puis renommage) plutôt que d'en écrire un second. Risque : une chirurgie manuelle des archives, à réserver au bar.

**Effort:** M (humain) / S (Claude Code + gstack)
**Priority:** P3
**Depends on:** Lot A du plan du 8 novembre 2026 (règle de bornage et réparation).

## Page participant

### « Chercher un autre duo » depuis le message de refus

**What:** Dans le message « X ne chantera pas « titre » avec Y : « raison » », un bouton qui ouvre la demande de duo ouvert pour ce titre.

**Why:** Après un refus, l'invitant doit aujourd'hui repasser par le menu ⋯ du titre pour chercher un autre partenaire.

**Context:** Proposé et reporté par la relecture du 9 novembre 2026 (X5), pour garder la page aussi légère que possible (demande du gérant). Le flux existe déjà : bouton « Chercher un duo » du titre (`data-duet-open`) et sa confirmation.

**Effort:** S (humain) / S (Claude Code + gstack)
**Priority:** P4
**Depends on:** Lots B et E du plan du 8 novembre 2026.
