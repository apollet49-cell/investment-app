# RECAP — InvestApp

*Présentation du projet pour le cours d'IA*

---

## Sommaire

1. [Contexte](#1-contexte)
2. [Objectifs](#2-objectifs)
3. [Le prompt de départ](#3-le-prompt-de-départ)
4. [Architecture & stack technique](#4-architecture--stack-technique)
5. [Le rôle de l'IA dans le projet](#5-le-rôle-de-lia-dans-le-projet)
6. [Étapes réalisées — chronologie](#6-étapes-réalisées--chronologie)
7. [Décisions techniques clés](#7-décisions-techniques-clés)
8. [Bugs marquants et résolutions](#8-bugs-marquants-et-résolutions)
9. [Résultats — le projet en chiffres](#9-résultats--le-projet-en-chiffres)
10. [Démo — script de présentation](#10-démo--script-de-présentation)
11. [Ouverture & roadmap](#11-ouverture--roadmap)
12. [Annexes](#12-annexes)

---

## 1. Contexte

### 1.1 Le mouvement FIRE

**FIRE** = *Financial Independence, Retire Early*. Un mouvement né dans les années 1990 aux États-Unis, popularisé après la crise de 2008. L'idée centrale :

> *Investir agressivement (50-70 % du revenu) pour atteindre l'indépendance financière le plus tôt possible — le moment où le rendement de son portefeuille couvre les dépenses sans avoir besoin de salaire.*

La règle des 4 % de Bengen (1994) sert de boussole : avec un patrimoine **25 fois** les dépenses annuelles, on peut en retirer 4 % par an indéfiniment sans toucher au capital. Exemple : 30 000 €/an de dépenses → cible = 750 000 € de patrimoine.

### 1.2 Le problème

Pour un investisseur FIRE en France, les outils existants étaient tous insatisfaisants :

| Outil | Problème |
|---|---|
| **Yahoo Finance** | Gratuit, mais affiche juste les prix. Pas de projection FIRE, pas de fiscalité française. |
| **Personal Capital / Empower** | Bons outils, mais 100 % orientés marché US. Pas de PEA, pas d'assurance-vie, pas de PER. |
| **Boursorama / Trade Republic** | Vue par compte, pas de consolidation cross-broker. Pas de XIRR honnête. |
| **Excel** | Fonctionne, mais demande maintenance manuelle perpétuelle. Pas de live market data. |

Trois lacunes critiques :
1. **ROI affichés trompeurs** — la plupart des trackers affichent un ROI moyen post-dépôt qui flatte l'utilisateur. Si tu déposes 10 000 € hier et que le marché monte 1 % aujourd'hui, le ROI apparent te fait croire que tu as gagné, alors que ton vrai XIRR pondéré par les dates de flux est largement plus bas.
2. **Fiscalité française absente** — les enveloppes françaises (PEA 5 ans, Assurance-Vie 8 ans, PER, flat tax 30 %) sont des structures fiscales spécifiques avec des règles complexes qu'aucun outil international ne modélise correctement.
3. **Pas d'aide à la décision** — voir les chiffres c'est une chose, savoir quoi en faire c'en est une autre. Aucun outil ne disait *« voici les 3 choses qui méritent ton attention ce mois-ci »*.

### 1.3 Le contexte du projet

Projet personnel **présenté dans le cadre d'un cours d'IA**. L'angle pédagogique central : démontrer comment intégrer un **LLM agentique** (Claude avec tool-use) dans une application web réelle pour résoudre un problème métier — pas un POC jouet, mais un produit fonctionnel et déployé.

Le projet a évolué sur **plusieurs mois** : démarrage par un MVP fonctionnel, refactors progressifs, ajout de features, débogage en prod, et finalement intégration de Claude comme **assistant agentique**.

---

## 2. Objectifs

### 2.1 Objectifs produit

- Construire un **tracker de portefeuille multi-actifs** (actions, ETF, crypto, immobilier, devises) qui :
  - Calcule des **rendements honnêtes** (XIRR money-weighted, TWR time-weighted, pas un ROI naïf gonflé par les dépôts récents)
  - Modélise la **fiscalité française réelle** (PEA, CTO, AV, PER, IFI, flat tax)
  - Valorise l'**immobilier via la DVF** (base officielle des transactions notariées françaises)
  - Affiche des **métriques de risque** (volatilité annualisée, max drawdown, beta vs S&P 500, ratio de Sharpe)
  - Projette le **FIRE** : en combien d'années avec le taux d'épargne actuel
  - Permet de simuler des **stress-tests** (crash -30 %, stagflation, hyperinflation)
  - Propose un **rééquilibrage** : compare l'allocation actuelle à une cible, suggère les transactions

### 2.2 Objectifs techniques

- **Code maintenable** : tests automatisés > 90 % de couverture critique, refactors réguliers, modules cohérents
- **Sécurité 2026** : CSP stricte, SRI sur CDN, JWT, rate-limit auth, clés API chiffrées Fernet
- **Performance** : première page < 3 s, navigation interne < 500 ms (SWR cache + Service Worker)
- **Multilingue de naissance** : français, anglais, chinois mandarin (pour l'écosystème étudiant à Taiwan)
- **Hébergement à coût quasi-nul** : tier gratuit Fly.io + SQLite sur volume = 0 €/mois pour ce niveau de trafic

### 2.3 Objectifs IA (cœur du cours)

- **Démontrer la valeur ajoutée d'un LLM agentique** vs un chatbot classique :
  - Tool-use API d'Anthropic
  - Boucle multi-rounds (jusqu'à 6 appels d'outils chaînés)
  - Anti-hallucination by design (Claude doit appeler des outils avant de répondre)
  - Transparence : affichage des outils utilisés sous chaque réponse
- **Sécurité de la clé API** : Fernet par utilisateur (AES-128-CBC + HMAC), pas de clé partagée
- **Boucle bornée** : cap à 6 rounds × 1 500 tokens par tour pour éviter les runaway loops

---

## 3. Le prompt de départ

> ⚠️ **Note méthodologique** : le projet a été développé sur plusieurs mois en sessions itératives avec Claude Code. Il n'existe pas un « prompt initial unique » — c'est un dialogue continu. Ci-dessous une **reconstitution crédible** de ce qu'aurait pu être le prompt d'amorçage si on devait recommencer le projet aujourd'hui.

```
Je veux construire une application web qui sera mon tracker de
portefeuille pour la stratégie FIRE (Financial Independence, Retire
Early). Le but : avoir UN seul écran qui me dit honnêtement où j'en
suis, sans le bullshit des trackers commerciaux.

Le contexte de l'utilisateur cible (moi) :
- Investisseur français, mix actions/ETF/crypto/immo
- Utilise PEA, CTO, assurance-vie, PER
- Veut savoir : suis-je en avance vers le FIRE ? quel impôt si je
  vendais tout aujourd'hui ? quel risque réel je porte ?

Architecture demandée :
- Backend Python avec FastAPI (j'aime la doc OpenAPI auto-générée)
- SQLite pour démarrer (migration Postgres si besoin plus tard)
- Frontend vanilla JS, ES modules, pas de framework — je veux pouvoir
  tout comprendre sans build step. Chart.js pour les graphiques.
- Auth maison avec JWT (pas d'Auth0 pour rester gratuit)
- Hébergement Fly.io région Tokyo (je suis à Taiwan, latence faible)

Fonctionnalités prioritaires :
1. CRUD de positions (achat, vente, dividende) avec live prices via
   yfinance + CoinGecko
2. Calcul XIRR (Newton-Raphson sur les flux datés) et TWR
3. Métriques de risque : vol annualisée, max drawdown, beta vs S&P,
   Sharpe
4. Fiscalité française : PEA (5 ans), AV (8 ans), flat tax 30 %
5. Projection FIRE selon règle des 4 %
6. Valorisation immobilier via la base DVF (etalab.gouv.fr)
7. Stress tests : que devient le portefeuille si crash -30 % ?

L'IA — le cœur du projet pour mon cours :
- Intégrer Claude (Anthropic) comme assistant agentique
- PAS un chatbot generic — un agent qui A ACCÈS aux vraies données du
  portefeuille via des function calls (tool-use)
- L'utilisateur peut poser des questions ouvertes en français :
    « quel est mon plus gros risque ? »
    « combien d'impôts si je vendais tout aujourd'hui ? »
    « suis-je en avance vers le FIRE ? »
- L'agent appelle 1-6 outils backend, lit les résultats, synthétise
- Boucle BORNÉE pour éviter les runaway (max 6 rounds, 1500 tokens/tour)
- Clé API chiffrée Fernet par utilisateur — pas une clé partagée

Contraintes :
- Hébergement < 1 €/mois (étudiant)
- Tout doit être testé (pytest, > 80 cas)
- Pas de Sentry, pas d'observability cloud — logs structurés + voilà
- Code en français/anglais mais commits en anglais

Critère de réussite :
- Je peux le démontrer en 5 minutes à un jury non-technique et qu'ils
  comprennent l'intérêt de l'approche agentique
- Le site est réellement utilisable, pas un POC qui plante
- Le coût d'hébergement reste à zéro
```

Ce prompt aurait amorcé le travail. La réalité a été une centaine de sessions Claude Code itératives, avec des allers-retours sur l'architecture (5 routers supprimés en cours de route — dette technique), des refactors massifs (`app.js` 1 219 lignes → 10 modules, idem pour `dashboard.js` et `investments.js`), et beaucoup de débogage en prod.

---

## 4. Architecture & stack technique

### 4.1 Vue d'ensemble

```
┌────────────────────────────────────────────────────────────────┐
│                  https://investment-app.fly.dev                │
│                   Fly.io · Région NRT (Tokyo)                  │
└─────────────────────────────┬──────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│                   FastAPI (Python 3.9)                         │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  13 ROUTERS                                              │  │
│  │  auth · investments · transactions · dashboard ·         │  │
│  │  market · calculator · scenarios · planning · tax ·      │  │
│  │  dividends · alerts · settings · chat (agentique)        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  27 SERVICES                                             │  │
│  │  performance (XIRR/TWR) · risk · fire · tax · live_value │  │
│  │  market_data · market_universe · dividends · diversif... │  │
│  │  ai_service · pdf_report · alerts_engine · ...           │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  SQLAlchemy 2.0 → SQLite sur volume persistant           │  │
│  │  7 tables : User · Investment · Transaction ·            │  │
│  │  PortfolioSnapshot · MarketCache · Alert · ApiKey        │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
└────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
      ┌──────────┐      ┌──────────┐       ┌──────────┐
      │ yfinance │      │CoinGecko │       │Anthropic │
      │ (gratuit)│      │ (gratuit)│       │ (Claude) │
      └──────────┘      └──────────┘       └──────────┘
```

### 4.2 Backend — Python / FastAPI

- **Framework** : FastAPI 0.110+, async/await partout
- **ORM** : SQLAlchemy 2.0, Pydantic 2.9 pour la validation
- **Auth** : PyJWT, bcrypt pour les hashes, slowapi (rate-limit en mémoire)
- **Sécurité** : Fernet pour chiffrer les clés API Anthropic par utilisateur
- **PDF** : ReportLab pour les rapports exportables
- **Tests** : pytest (97 → 102 tests selon les phases), conftest hermétique
- **Logs** : structlog avec contexte par requête

### 4.3 Frontend — Vanilla ES Modules

Choix délibéré : **pas de framework**. Pas de React, pas de Vue, pas de build step.

Pourquoi ?
- Le projet doit rester **transparent** pour la présentation : pas de magie black-box
- Zéro étape de build = zéro problème de versionning d'outils
- Le DOM natif + modules ES + Chart.js (CDN avec SRI) couvrent 100 % du besoin
- Performance excellente : pas de hydration, pas de virtual DOM

**Organisation** :
- `app.js` (380 lignes après refactor) : orchestration, routing hash-based, state global
- `app/cache.js` : SWR (stale-while-revalidate) maison
- `app/ui.js` : toasts, modals, animations
- `app/fx.js` : taux de change USD↔devises
- `app/analytics.js` : tracking événements (PostHog)
- `app/auth_ui.js` : landing page v2 + sign-in modal
- `views/*.js` : 22 modules de vues (dashboard, investments, fire, tax, etc.)
- `i18n.js` : dictionnaire 3 langues (fr/en/zh)

### 4.4 Infrastructure

- **Hébergement** : Fly.io tier gratuit
- **Région** : NRT (Tokyo) — latence < 100 ms depuis Taiwan
- **Storage** : SQLite sur volume persistant Fly (3 Go inclus)
- **HTTPS** : Let's Encrypt auto-géré par Fly
- **Déploiement** : `fly deploy` depuis local, ~3-5 min de build
- **Backup** : snapshot quotidien du volume (perte max = 24 h)
- **CDN** : jsdelivr + unpkg pour Chart.js et lightweight-charts (avec SRI)
- **Coût** : **0 €/mois** au niveau de trafic actuel

---

## 5. Le rôle de l'IA dans le projet

### 5.1 Trois usages distincts

| Usage | Modèle | Quoi |
|---|---|---|
| **Assistant agentique (cœur)** | claude-sonnet-4 | Chat avec accès tool-use à 10 outils du portefeuille |
| **Revue mensuelle** | claude-sonnet-4 | Rédaction d'une revue de portefeuille de 1 page le 1er du mois |
| **Co-pilote de développement** | Claude Code (session interactive) | Code, refactor, débogage du projet lui-même |

### 5.2 Le chat agentique en détail

C'est **la killer feature** pour un cours d'IA.

**Architecture** :

```
┌──────────────────────────────────────────────────────────────┐
│  POST /chat/ask                                              │
│  { message: "Suis-je en avance vers le FIRE ?", history }    │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  routers/chat.py                                             │
│                                                              │
│  for round in range(MAX_TOOL_ROUNDS = 6):                    │
│    response = claude.messages.create(                        │
│      model="claude-sonnet-4",                                │
│      max_tokens=1500,                                        │
│      system=SYSTEM_PROMPT,                                   │
│      tools=TOOLS,  # 10 outils                               │
│      messages=messages                                       │
│    )                                                         │
│    if not tool_use_blocks: break                             │
│    for tool_use in tool_use_blocks:                          │
│      result = await _run_tool(name, args, user, db)          │
│      messages.append({"role": "user",                        │
│                       "content": [tool_result]})             │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│  Tools dispatch — chacun appelle un handler de router        │
│  existant :                                                  │
│                                                              │
│  get_portfolio_summary    → dashboard.summary                │
│  list_investments         → investments.list                 │
│  get_performance_metrics  → dashboard.performance            │
│  get_risk_metrics         → dashboard.risk                   │
│  get_history_vs_benchmark → dashboard.history                │
│  get_tax_simulation       → tax.simulate                     │
│  get_fire_projection      → planning.fire                    │
│  run_stress_test          → planning.stress_test             │
│  get_dividends_estimate   → dividends.calendar               │
│  list_alerts              → alerts.list                      │
└──────────────────────────────────────────────────────────────┘
```

**System prompt** :

> *« You are InvestAI, the embedded assistant of an investment portfolio tracker. Always call tools to get real numbers before answering — never fabricate values. French-friendly: if the user writes in French, answer in French; otherwise English. Never give generic financial-advisor disclaimers. »*

**Sécurité de la clé API** :
- Chaque utilisateur a sa propre clé Anthropic
- Stockée chiffrée **Fernet** (AES-128-CBC + HMAC-SHA256) en base
- Décryptée à la volée pour chaque requête
- Personne — pas même l'admin — ne peut lire les clés en clair

**Bornes de sécurité** :
- 6 rounds max d'appels d'outils par message
- 1500 tokens max par tour
- Pas de runaway loop possible

### 5.3 Exemple de boucle agentique réelle

**Question utilisateur** :
> *« Suis-je en avance vers le FIRE ? Et si je vendais tout aujourd'hui, combien je paierais en impôts ? »*

**Round 1** : Claude appelle `get_portfolio_summary` → `{total_value: 47830, total_invested: 42100, roi_pct: 13.6}`

**Round 2** : Claude appelle `get_fire_projection(monthly_expenses=2000, monthly_savings=1500)` → `FIRE atteint dans 18 ans, en avance de 2 ans sur la moyenne`

**Round 3** : Claude appelle `get_tax_simulation(tmi=30, pea_years=4, av_years=2)` → `{tax_due: 1719, effective_rate: 30.0, breakdown: {pea: 0, av: 1719, cto: 0}}`

**Round 4** : Claude synthétise en français en utilisant les vraies données :
> *« Tu es en avance — ton portefeuille de 47 830 € avec 1 500 €/mois d'épargne te place sur une trajectoire FIRE à 18 ans, 2 ans devant la moyenne. Si tu vendais tout aujourd'hui, tu paierais environ 1 719 € d'impôts (5 730 € de plus-values × 30 % flat tax). Note que la totalité provient de ton assurance-vie : ton PEA est encore avant 5 ans donc imposable, et tu n'as rien en CTO. »*

Sous la réponse apparaît :
> *↳ used: get_portfolio_summary · get_fire_projection · get_tax_simulation*

L'utilisateur voit la trace — **transparence totale**, pas d'hallucination possible.

---

## 6. Étapes réalisées — chronologie

### 6.1 Phase 1 — Fondations (semaines 1-3)

- Setup FastAPI + SQLAlchemy + JWT
- Schéma de base : User, Investment, Transaction
- CRUD investissements
- Auth (login, register, demo account)
- Premier déploiement Fly.io

### 6.2 Phase 2 — Données marché (semaines 4-5)

- Intégration yfinance pour les actions/ETF
- Intégration CoinGecko pour les cryptos
- Cache en mémoire avec TTL
- Live refresh des current_value (background)
- Gestion des fuseaux horaires (UTC partout côté serveur)

### 6.3 Phase 3 — Calculs financiers (semaines 6-8)

- `services/performance.py` : XIRR (Newton-Raphson), TWR, ROI simple
- `services/risk.py` : volatilité annualisée, max drawdown, beta, Sharpe, score composite
- `services/fire.py` : projection FIRE (règle 4 %, espérance, scénarios pessimiste/réaliste/optimiste)
- `services/tax.py` : simulation PEA/CTO/AV/PER
- Tests unitaires sur tous les calculs

### 6.4 Phase 4 — Frontend Landing v2 (semaines 9-10)

- Landing page complète redesignée (style Geist/Linear)
- Sections : hero, "le mensonge des trackers", benchmark, enveloppes fiscales, DVF, revue mensuelle, stats, CTA
- 2 charts interactifs : hero (sélecteur 1M/3M/YTD/1Y/ALL) + benchmark (XIRR/TWR/Δ bps)
- PWA installable
- i18n FR/EN/ZH

### 6.5 Phase 5 — Refactors massifs (semaines 11-12)

Trois fichiers étaient devenus illisibles à force d'ajouts incrémentaux :

| Fichier | Avant | Après | Méthode |
|---|---|---|---|
| `static/app.js` | 1 219 lignes | 380 lignes + 5 modules | Découpe par responsabilité (routing, cache, UI, FX, analytics, auth) |
| `static/views/dashboard.js` | 916 lignes | 6 modules | Sub-loaders pour chaque carte |
| `static/views/investments.js` | 1 511 lignes | 8 modules | State, form, modal, table, detail séparés |
| `services/pdf_report.py` | 758 lignes | Module package | Helpers (hero, KPI strip, charts, risk table) séparés |

Aucune régression — 92 tests verts avant, 92 après.

### 6.6 Phase 6 — Sécurité (semaine 13)

- **CSP stricte** : script-src/style-src/font-src/connect-src spécifiques
- **HSTS** : Strict-Transport-Security 1 an
- **X-Frame-Options DENY** + X-Content-Type-Options nosniff
- **SRI** sur Chart.js (sha384)
- **Rate-limit** auth (slowapi en mémoire) : 5 logins/5min/IP, 3 register/10min/IP
- **Référencement** : pages `/disclaimer` et `/sources` accessibles depuis le footer

### 6.7 Phase 7 — Anti-rollback (semaines 14-15)

Problème observé en prod : *« le dashboard s'affiche à la place de la bonne page »*.

Cause : les vues async terminaient leur rendu APRÈS qu'une nouvelle vue avait pris la main, et écrasaient son DOM.

3 vagues de fixes :
- **v1** : token de rendu sur le `view-root`, chaque vue vérifie qu'elle est encore propriétaire avant chaque write
- **v2** : étendu à 8 vues (fire, transactions, scenarios, rebalance, tax, review, settings)
- **v3** : force refresh du service worker à chaque deploy (VIEW_VERSION bumpé)

### 6.8 Phase 8 — Performance (semaine 16)

- Endpoint `/dashboard/all` qui fan-out les 7 sous-appels en parallèle
- Timeouts par sous-appel (2.5 s pour dividendes, 5 s pour le reste)
- **Cache Postgres maison** pour les dividendes (TTL 24h) — économise 18 s/login
- SWR cache côté client : navigation instantanée entre vues déjà visitées
- Service Worker offline-first

### 6.9 Phase 9 — Polish & UX (semaine 17)

- Disclaimer + sources cliquables en bas de page
- Section "company" supprimée (pas une vraie company)
- News : bascule de Yahoo Finance RSS (limité, US-only) vers **Google News RSS** (vraies actualités)
- Fix des graphiques crypto (Bitcoin → BTC-USD via table de mapping)
- Fix de l'affichage ROI (« ++22,81 % » → « +22,81 % »)
- Tests : conftest stable (plus de dépendance d'ordre via SENTRY_ENV=test)

### 6.10 Phase 10 — Chat agentique (semaine 18) **— LE CŒUR DU PROJET**

- `routers/chat.py` (~250 lignes) avec la boucle agentique complète
- 10 outils exposés à Claude avec leur input_schema JSON
- System prompt anti-hallucination
- Frontend `views/chat-panel.js` : bouton flottant, panel slide-in, markdown rendering
- Anti-fuite : clé Anthropic chiffrée Fernet par utilisateur

### 6.11 Phase 11 — Features additionnelles (semaine 19)

- **Compare 2 assets** (`/#/compare`) : rebase à 100 sur première date commune
- **Risk view** (`/#/risk`) : score, vol, max DD, Sharpe, beta + equity curve + underwater chart
- Drawdown chart : peak monotone, drawdown = (v - peak) / peak

### 6.12 Phase 12 — Bugfixes critiques en prod (semaine 20)

- **Bug Rolls-Royce -97 %** : `_yf_price_on_date_sync` hardcodait `currency: "USD"`. Pour les actions de la bourse de Londres (.L) qui sont cotées en **pence**, ça faisait stocker une quantité 100× trop petite, d'où l'affichage d'une perte de -97 % sur un stock qui avait en fait doublé.
- **Fix audit complet** : `_yf_price_on_date_sync`, `get_price_on_date`, `get_historical` corrigés
- **Endpoint de réparation** `/investments/repair-all-cost-basis` : recalcule la cost basis pour 24 marchés étrangers (.L .PA .AS .DE .SW .MI .HK .T .TO .AX .BR .MC .ST .HE .OL .VI .LS .NS .BO .SI .KQ .KS .SS .SZ .TW)
- **Bouton « Repair FX »** dans la toolbar Investments

---

## 7. Décisions techniques clés

### 7.1 Pourquoi vanilla JS et pas React/Vue ?

**Raisons** :
- Transparence pour la présentation : pas de magie black-box
- Zéro build step = zéro toolchain à versionner
- Performance optimale : pas de hydration, pas de bundle 200 ko
- Coût cognitif : un étudiant qui ouvre le code comprend tout en 30 min

**Contrepartie** : pour les vues complexes (investments, dashboard), il fallait découper en sous-modules manuellement.

### 7.2 Pourquoi SQLite et pas Postgres ?

- Le projet a 1 utilisateur principal (moi-même qui présente) + quelques démos
- SQLite sur volume Fly = **0 €/mois** vs Postgres managé minimum 7 $/mois
- SQLite gère parfaitement 100 RPS, on en est loin
- Migration vers Postgres triviale si besoin (juste le `DATABASE_URL`)

**Quand SQLite poserait problème** :
- Si plusieurs workers Fly en parallèle (locking)
- À partir de ~10 GB de données
- Avec des transactions concurrentes massives

### 7.3 Pourquoi Fly.io région Tokyo ?

- Je suis à **Taiwan** pendant le développement → latence < 100 ms depuis NRT
- Le tier gratuit Fly.io n'est limité ni en région ni en bande passante
- L'auto-stop après inactivité économise l'instance, mais réveil < 10 s à la première requête
- Alternative testée : Render → trop lent pour les wake-ups (parfois 30 s)

### 7.4 Pourquoi Anthropic et pas OpenAI ?

- **Tool-use API supérieure** chez Anthropic (plus déterministe, meilleur respect du schema JSON)
- **Contexte de 200K** sur Sonnet 4 → on peut envoyer un historique long sans craindre la troncature
- **Politique de privacy** plus claire (pas d'entraînement sur les requêtes API)
- **Prix compétitif** : claude-sonnet-4 est moins cher que gpt-4o pour des performances comparables
- **Préférence personnelle** assumée : j'aime travailler avec Claude

### 7.5 Pourquoi yfinance et pas une API payante ?

- **Gratuit**, pas de quota strict (rate-limited mais workable)
- Couvre **toutes les bourses mondiales** (US, Europe, Asie, crypto via BTC-USD)
- Limites : pas de live tick-by-tick (delay 15-20 min sur certaines bourses), changements de schéma possibles
- Alpha Vantage en fallback (gratuit jusqu'à 25 req/jour)

### 7.6 Pourquoi pas de Sentry / Datadog ?

- Coût (Sentry démarre à 26 $/mois)
- Mon usage personnel ne justifie pas
- Logs structurés + `fly logs` couvrent 95 % du besoin de debug

---

## 8. Bugs marquants et résolutions

### 8.1 Bug Rolls-Royce -97 % (le plus instructif)

**Symptôme** : Position RR.L (Rolls-Royce, bourse de Londres) avec $1.2M investis affichait $35k de valeur courante. ROI : **-97,07 %**. Mais le graphique du sous-jacent montrait une hausse de +100 % sur la période.

**Diagnostic** : 
```python
# services/market_universe.py:64 (avant fix)
return {
    "price": float(last["Close"]),
    "currency": "USD",  # ← HARDCODÉ !
    ...
}
```

yfinance retourne les prix RR.L en **pence** (1 livre = 100 pence). Le code traitait cette valeur (~600 pence) comme si c'était des dollars.

**Conséquence** :
- Quantité stockée = $1,200,000 / $600 = 2 000 actions (au lieu des ~160 000 réelles)
- Refresh live correctement converti : 1300p → £13 → $16
- Current value = 2 000 × $16 = **$32 000** ≈ ce qui s'affichait

**Fix** (sur 3 endpoints) :
- `_yf_price_on_date_sync` : lit maintenant la devise via `t.fast_info.currency`
- `get_price_on_date` : applique pence → pound → USD
- `get_historical` : même pipeline pour les charts
- **+ endpoint `/investments/repair-all-cost-basis`** pour réparer les positions existantes

5 tests de régression couvrent : pence GBp, GBP > 500 (heuristique fallback), GBP < 500 (vrais pounds), USD passthrough, EUR Xetra.

### 8.2 Bug rollback fantôme

**Symptôme** : Click sur "Investments" → la vue s'affiche → 1 seconde plus tard le dashboard revient s'imprimer dessus.

**Cause** : Le `loadXxx` async de la vue précédente terminait après que la nouvelle ait pris la main et écrasait le DOM.

**Fix** : Token de rendu sur `view-root`. Chaque vue capture un ID au démarrage, vérifie avant chaque write qu'elle est toujours la propriétaire. Si le token a changé, elle abandonne.

### 8.3 Bug dashboard 28 secondes

**Symptôme** : Page blanche avec un spinner pendant 28 s après login.

**Cause** : Endpoint `/dashboard/all` faisait 7 fetches en parallèle, dont les dividendes qui faisaient un yfinance par position (~18 s pour 20 holdings). UN service lent bloquait toute la réponse.

**Fix** : Timeout par sous-appel (2.5 s pour dividendes, 5 s pour le reste). En timeout, la clé renvoie `null` et le reste du dashboard s'affiche. + cache Postgres maison TTL 24h pour les dividendes.

### 8.4 Bug crypto 404

**Symptôme** : Click sur Bitcoin → « Graphique indisponible ».

**Cause** : Le frontend appelait `/market/historical/bitcoin`. Mais yfinance ne connaît que `BTC-USD`.

**Fix** : Table de traduction `_COINGECKO_TO_YF` avec 21 cryptos mappées (`bitcoin → BTC-USD`, `ethereum → ETH-USD`, etc.) + fallback `{SYMBOL}-USD` en majuscules.

### 8.5 Bug tests fragiles

**Symptôme** : `pytest tests/` passe, `pytest -p random_order` : 5 échecs.

**Cause** : Le test `test_auth_rate_limit_fires` désactivait le rate-limit en cours de session. Les autres tests d'auth en bénéficiaient par accident. Sans ce test d'abord, ils étaient bloqués.

**Fix** : `conftest.py` force `SENTRY_ENV=test` pour que `INVESTAPP_DISABLE_RATE_LIMIT` soit honoré dès le boot. Plus aucune dépendance d'ordre.

### 8.6 Bug CSP Google Fonts

**Symptôme** : Console : `Refused to load 'https://fonts.googleapis.com/css2?...'`.

**Cause** : CSP initiale n'autorisait pas les domaines de fonts.

**Fix** : Ajout de `fonts.googleapis.com` à `style-src`, `fonts.gstatic.com` à `font-src`. CSP toujours stricte sur le reste.

### 8.7 Bug double-+ ROI (« ++22,81 % »)

**Symptôme** : Affichage avec deux signes plus.

**Cause** : `pct()` émettait déjà le `+` pour les positifs, et le code de rendu ajoutait un `roiSign` par-dessus.

**Fix** : Suppression du préfixe redondant. Un seul endroit formate = un seul signe.

### 8.8 Bug demo CTA bloqué

**Symptôme** : Click sur « Try the demo » → succès → app s'ouvre → logout → retour landing → bouton encore « Setting up your demo… » et désactivé.

**Cause** : Sur succès, le bouton n'était jamais reset — seulement sur erreur.

**Fix** : Stash du label original en `data-original-label` au premier clic, reset systématique avant `bootApp()` côté succès, + `resetDemoCtas()` appelé dans `showAuth()` (defense in depth).

---

## 9. Résultats — le projet en chiffres

### 9.1 Code

| Catégorie | Valeur | Détail |
|---|---|---|
| **Lignes de code totales** | ~21 000 | Python + JS + HTML/CSS + tests |
| Backend Python | 8 907 | 56 fichiers |
| Frontend JavaScript | 7 592 | 33 modules ES |
| HTML / CSS | 2 985 | 1 fichier HTML + landing.css + style.css |
| Tests automatisés | 1 372 | 102 tests pytest |

### 9.2 Backend

| Catégorie | Valeur | Détail |
|---|---|---|
| Endpoints API REST | **69** | /auth, /dashboard, /investments, /chat, /market, ... |
| Routers FastAPI | 13 | Un par domaine métier |
| Services backend | 27 | Logique métier découplée des routes |
| Tables BDD | 7 | User, Investment, Transaction, PortfolioSnapshot, MarketCache, Alert, ApiKey |
| **Outils Claude exposés** | **10** | Function calling agentique |

### 9.3 Qualité & Sécurité

| Catégorie | Valeur | Détail |
|---|---|---|
| Tests pytest | **102 / 102 ✅** | Tous verts, isolation per-test, BDD éphémère |
| Headers de sécurité | 6 | CSP, HSTS, X-Frame, X-Content, Referrer, Permissions |
| Chiffrement des clés API | Fernet | AES-128-CBC + HMAC-SHA256 |
| Rate-limit auth | 5 / 5 min | slowapi, par IP |
| Bugs résolus tracés | 16 | 12 réels + 4 latents défendus en amont |
| SRI sur CDN | sha384 | Chart.js, lightweight-charts |

### 9.4 Produit & Marché

| Catégorie | Valeur |
|---|---|
| Langues UI | 3 (FR / EN / ZH) |
| Types d'actifs supportés | 5 (action, ETF, crypto, immo, devise) |
| Cryptos supportées | 21 mappings curated + fallback |
| Marchés étrangers couverts | 24 suffixes (.L .PA .DE ...) |
| Devises FX gérées | 30+ |
| Périodes d'analyse | 5 (1M, 3M, 6M, 1Y, 5Y) |

### 9.5 Infrastructure & Coûts

| Catégorie | Valeur |
|---|---|
| Hébergement | Fly.io région NRT (Tokyo) |
| Coût mensuel | **0 €** |
| Latence depuis Taiwan | < 100 ms |
| Latence depuis Europe | < 250 ms |
| Backup | Snapshot quotidien (perte max 24 h) |
| Cache marché | TTL 24h (Postgres maison) |

### 9.6 Activité de développement

| Métrique | Valeur |
|---|---|
| Commits Git | 100+ |
| Sessions Claude Code | ~80 (estimation) |
| Refactors majeurs | 4 (app.js, dashboard.js, investments.js, pdf_report.py) |
| Bugs critiques en prod résolus | 3 (Rolls-Royce, rollback fantôme, dashboard 28s) |

### 9.7 Estimation prix marché

| Poste | Jours | Coût |
|---|---|---|
| UX/design | 6 | 4 000 € |
| Backend FastAPI + 13 routers + 69 endpoints + auth | 20 | 12 000 € |
| Frontend ES modules + 33 vues + i18n | 20 | 12 000 € |
| Intégration IA agentique (10 outils, tool-use) | 10 | 6 000 € |
| Tests + sécurité + déploiement | 10 | 6 000 € |
| **Total** | **66 jours** | **~40 000 €** |

À 600 €/jour facturé en France pour un dev full-stack senior. Le projet étant en solo, les coûts de coordination sont à zéro.

---

## 10. Démo — script de présentation

**Durée cible : 5 minutes**

### 10.1 Minute 0:00 - 0:30 — Pitch
- Ouvrir https://investment-app.fly.dev
- *« InvestApp est un tracker de portefeuille pour la stratégie FIRE, avec un assistant IA agentique qui interroge tes vraies données. »*

### 10.2 Minute 0:30 - 1:30 — Dashboard
- Login (compte démo en 1 clic)
- Montrer les 6 cartes : summary, performance, history vs S&P, risk, dividends, FIRE
- Pointer que chaque carte fait son propre endpoint avec timeout indépendant

### 10.3 Minute 1:30 - 2:30 — Risk view
- Click sur "Risk" dans la sidebar
- Montrer les 5 tuiles : score, vol, max DD, Sharpe, beta
- Montrer l'equity curve, puis le **underwater chart** (drawdown au cours du temps)
- *« Le 'max drawdown : -28 %' dans une tuile, c'est un chiffre. Le voir tracé sur 5 ans, c'est une expérience émotionnelle. »*

### 10.4 Minute 2:30 - 4:00 — Chat agentique **(CŒUR DE LA DÉMO)**
- Clic sur le bouton chat en bas à droite
- Poser : *« Suis-je en avance vers le FIRE et combien je paierais en impôts si je vendais tout ? »*
- Pendant l'attente : pointer le badge `↳ used: ...` qui va apparaître
- Lire la réponse en montrant qu'elle utilise les vrais chiffres de la démo

### 10.5 Minute 4:00 - 4:30 — Compare
- Page Compare
- Taper MSFT vs AAPL sur 5Y
- Pointer le rebase à 100

### 10.6 Minute 4:30 - 5:00 — Architecture
- Slide architecture
- Pointer les 3 piliers : **FastAPI** (backend), **Claude tool-use** (IA), **Fly.io Tokyo** (hébergement)
- Conclusion : *« 21 000 lignes de code, 102 tests, déployé pour 0 €/mois, agentique de bout en bout. »*

### 10.7 Plan B si le wifi est lent

Tous les écrans clés sont capturables en screenshot la veille. Le chat agentique peut être démontré en différé via une vidéo de 30 s (mais c'est toujours plus impressionnant en live).

---

## 11. Ouverture & roadmap

### 11.1 Ce qui rend le site utilisable AUJOURD'HUI

- URL publique stable : `investment-app.fly.dev`
- Premier load < 3 s, navigation interne < 500 ms
- HTTPS de bout en bout (Let's Encrypt auto-géré)
- PWA installable sur mobile (icône sur écran d'accueil)
- Cache offline-first (navigation hors-ligne possible)
- Auto-deploy à chaque push sur `main`
- Backup BDD quotidien
- Multilingue (FR / EN / ZH)

### 11.2 Roadmap

**Court terme (1-2 mois)**
- Import des transactions depuis broker (Boursorama, Trade Republic, Bourse Direct) via CSV puis API
- Alertes email quotidiennes (drawdown > seuil, dividende détecté, déviation d'allocation)
- Mode read-only partageable (lien sans droits d'écriture pour un parent / un conseiller)

**Moyen terme (3-6 mois)**
- Portefeuilles multiples par utilisateur (perso, retraite, projet enfants)
- App mobile native en partant du PWA existant (Capacitor)
- Inflation locale en temps réel (FRED, INSEE) pour des projections vraiment ancrées

**Long terme — L'agent va plus loin**
- Claude surveille en continu et alerte de manière proactive (« ta crypto représente 35 % de ton portefeuille, est-ce voulu ? »)
- Suggestions de rebalances trimestrielles, prêtes à exécuter en 1 clic
- Mode « avocat du diable » : Claude challenge ta thèse d'investissement avant chaque gros achat

### 11.3 Ce que je referais différemment

- **Décider Postgres dès le départ** — SQLite tient pour la démo mais bloquerait toute mise à l'échelle sérieuse
- **Mettre en place les types Pydantic plus stricts** dès le début (les schémas ont mûri pendant le projet)
- **Setup CI complet** (GitHub Actions) plus tôt — actuellement les tests tournent en local + manuellement avant deploy
- **PostHog dès le jour 1** pour avoir un baseline UX (taux de complétion du form d'ajout d'investissement, par exemple)

---

## 12. Annexes

### 12.1 Liens utiles

- **Site en production** : https://investment-app.fly.dev
- **Repo GitHub** : (privé, présenté en démo locale)
- **Disclaimer légal** : https://investment-app.fly.dev/disclaimer
- **Sources de données** : https://investment-app.fly.dev/sources

### 12.2 Glossaire

| Terme | Définition |
|---|---|
| **FIRE** | Financial Independence, Retire Early — atteindre l'indépendance financière le plus tôt possible |
| **XIRR** | Extended Internal Rate of Return — taux qui équilibre la NPV des cashflows datés (money-weighted) |
| **TWR** | Time-Weighted Return — rendement neutralisé du timing des cashflows |
| **Drawdown** | Perte peak-to-trough exprimée en % (sous l'eau par rapport au plus haut) |
| **Sharpe** | Ratio (rendement - taux sans risque) / volatilité — récompense par unité de risque |
| **Beta** | Covariance avec un benchmark — sensibilité aux mouvements du marché |
| **PEA** | Plan d'Épargne en Actions — enveloppe française fiscalement avantageuse après 5 ans |
| **CTO** | Compte-Titres Ordinaire — pas d'avantage fiscal, mais aucun plafond, flat tax 30 % |
| **AV** | Assurance-Vie — enveloppe française avantageuse après 8 ans (7,5 % + PS sur intérêts) |
| **PER** | Plan d'Épargne Retraite — déduction de l'impôt sur le revenu à l'entrée |
| **DVF** | Demandes de Valeurs Foncières — base officielle des transactions notariées françaises |
| **Tool-use** | API Anthropic qui permet à Claude d'appeler des fonctions définies par le développeur |
| **CSP** | Content Security Policy — header HTTP qui restreint les origines des ressources |
| **SRI** | Subresource Integrity — hash vérifié sur les ressources externes CDN |
| **Fernet** | Schéma de chiffrement symétrique authentifié (AES-128-CBC + HMAC-SHA256) |

### 12.3 Commandes utiles

**Démarrer le serveur local** :
```bash
uvicorn main:app --reload
```

**Tests** :
```bash
pytest -q
```

**Déploiement** :
```bash
fly deploy
```

**Logs production** :
```bash
fly logs
```

**Redémarrer la machine** :
```bash
fly machine list
fly machine restart <id>
```

### 12.4 Structure du repo

```
investment_app/
├── main.py                    # FastAPI app entry point
├── settings.py                # Pydantic Settings (env vars)
├── database.py                # SQLAlchemy engine + session
├── models.py                  # ORM tables (7 modèles)
├── schemas.py                 # Pydantic input/output schemas
├── auth.py                    # JWT + bcrypt
├── crypto.py                  # Fernet wrapping
├── routers/                   # 13 routers FastAPI
│   ├── auth.py
│   ├── chat.py                # ← Le cœur agentique
│   ├── dashboard.py
│   ├── investments.py
│   └── ...
├── services/                  # 27 services métier
│   ├── ai_service.py
│   ├── performance.py         # XIRR / TWR
│   ├── risk.py                # Vol / DD / Beta / Sharpe
│   ├── fire.py                # Projection FIRE
│   ├── tax.py                 # Fiscalité française
│   ├── live_value.py          # Refresh des current_value
│   ├── market_data.py         # yfinance / Alpha Vantage
│   ├── market_universe.py     # Search + historical
│   └── ...
├── static/                    # Frontend (vanilla ES modules)
│   ├── index.html             # Landing v2 (preloaded)
│   ├── app.js                 # SPA shell
│   ├── i18n.js                # FR / EN / ZH
│   ├── style.css              # Theme tokens
│   ├── landing.css            # Landing v2 dark theme
│   ├── app/                   # cache, ui, fx, analytics, auth_ui
│   └── views/                 # 22 modules de vues
│       ├── dashboard.js
│       ├── investments.js
│       ├── chat-panel.js      # ← Floating chat
│       ├── compare.js
│       ├── risk.js
│       └── ...
└── tests/                     # 102 tests pytest
    ├── conftest.py
    ├── test_calculator.py
    ├── test_integration.py
    ├── test_lse_price_normalization.py
    └── ...
```

---

*Document généré pour la présentation du projet. Pour toute question technique : démo en live sur https://investment-app.fly.dev.*
