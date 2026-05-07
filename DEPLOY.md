# Mettre l'app en ligne

Trois options du plus rapide au plus pérenne.

## Option A — URL publique temporaire en 30 secondes (`ngrok`)

Idéal pour montrer le site à quelqu'un *maintenant*, sans hébergement.

```bash
# 1. Installe ngrok
brew install ngrok        # ou : curl -s https://ngrok.com/static/install.sh | bash

# 2. Lance le serveur local (s'il ne tourne pas déjà)
cd investment_app
source .venv/bin/activate
uvicorn main:app --port 8000

# 3. Dans un autre terminal, ouvre un tunnel
ngrok http 8000
```

Tu obtiens une URL `https://xxxx-xx-xx-xx-xx.ngrok-free.app` — partageable, valable tant que ton terminal reste ouvert. **Ton ordinateur doit rester allumé**, sinon le site disparaît.

Limites du gratuit : URL change à chaque redémarrage, plafond de bande passante, message d'avertissement à la première visite.

---

## Option B — Hébergement gratuit permanent : Render.com (**recommandé**)

C'est le plus simple pour avoir une URL stable, gratuite, avec base de données qui survit aux redéploiements.

### Pré-requis
- Un compte GitHub (gratuit)
- Un compte Render.com (gratuit, signup avec GitHub)
- Tes clés API (Alpha Vantage, Open Exchange Rates, FRED — toutes gratuites, voir les liens dans `.env.example`)

### Étapes

**1. Pousse le code sur GitHub**

```bash
cd investment_app
git init
git add .
git commit -m "Initial deploy"
gh repo create investment-app --private --source=. --remote=origin --push
# (ou crée le repo manuellement sur github.com et fais git push)
```

**2. Génère ta clé Fernet locale** (à coller dans Render plus tard) :

```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

Copie la sortie (du genre `TmRfP_kXsJ3Uo...=`) dans un fichier temporaire.

**3. Déploie sur Render**

- Va sur [render.com/dashboard](https://dashboard.render.com), clique **New → Blueprint**
- Connecte ton repo GitHub
- Render détecte automatiquement `render.yaml`
- Clique **Apply**

**4. Configure les variables secrètes**

Render te demande de remplir les variables `sync: false` :
- `APP_ENCRYPTION_KEY` → colle la clé Fernet générée à l'étape 2
- `ALPHA_VANTAGE_KEY` → ta clé Alpha Vantage
- `OPEN_EXCHANGE_RATES_KEY` → ta clé Open Exchange Rates
- `FRED_KEY` → ta clé FRED
- `ANTHROPIC_API_KEY` → optionnel (les users peuvent mettre la leur dans Settings)

Render lance le build (3-5 min). À la fin tu as une URL `https://investment-app-xxx.onrender.com`.

**5. (Optionnel) Domaine perso**

Dans le dashboard Render → Settings → Custom Domain. Suis les instructions DNS.

### Limites du free tier
- L'app **s'endort après 15 minutes d'inactivité** — la première visite après une pause prend ~30 s pour redémarrer. Passer au plan Starter ($7/mois) supprime ça.
- 750 heures gratuites par mois (suffit pour 1 service tournant 24/7).
- Disque 1 Go : largement assez pour SQLite.

---

## Option C — Hébergement propre avec Docker : Fly.io

Plan gratuit plus généreux que Render (3 micro-VMs, 3 Go de stockage), pas d'endormissement.

```bash
# 1. Installer flyctl
brew install flyctl

# 2. Se connecter
fly auth signup

# 3. Lancer (depuis investment_app/)
fly launch --copy-config --no-deploy

# 4. Créer le volume persistant pour SQLite
fly volumes create investment_data --size 1 --region cdg

# 5. Définir les secrets
fly secrets set \
  APP_ENCRYPTION_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')" \
  JWT_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(64))')" \
  ALPHA_VANTAGE_KEY="ta_clé" \
  OPEN_EXCHANGE_RATES_KEY="ta_clé" \
  FRED_KEY="ta_clé" \
  ANTHROPIC_API_KEY="ta_clé_optionnelle"

# 6. Déployer
fly deploy
```

Tu obtiens `https://investment-app.fly.dev`. Domaine custom : `fly certs create exemple.fr`.

---

## Récap'

| Option   | Setup     | URL                          | Coût            | Idéal pour                 |
|----------|-----------|------------------------------|-----------------|----------------------------|
| ngrok    | 30 s      | aléatoire, change            | gratuit         | montrer une démo en live    |
| Render   | 5-10 min  | `xxx.onrender.com`           | gratuit (sleep) | 1er hébergement permanent  |
| Fly.io   | 10-15 min | `xxx.fly.dev`                | gratuit (3 VMs) | usage prod, pas de sleep   |

## Avant de partager publiquement

L'app est conçue pour un usage **single-worker** (le scheduler APScheduler et l'état SSE sont en mémoire). Pour scaler horizontalement il faudrait :
- Migrer SQLite → Postgres (changer `DATABASE_URL`)
- Externaliser la pub/sub SSE vers Redis
- Restreindre l'inscription (pour l'instant `/auth/register` est ouvert à tous)

Pour un site perso ou démo : c'est prêt à l'emploi.
