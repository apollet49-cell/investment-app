from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import OAuth2PasswordBearer
from jwt.exceptions import InvalidTokenError
from passlib.context import CryptContext
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.orm import Session

from database import get_db
from models import User
from schemas import TokenResponse, UserLogin, UserOut, UserRegister
from settings import settings

# Per-IP in-memory rate limits on the three public auth endpoints. The
# single-worker uvicorn deployment means in-memory counters are
# authoritative; swap the storage URI for redis://… if scaling out.
# Tests set INVESTAPP_DISABLE_RATE_LIMIT=1 so the auth_token fixture can
# register one user per test without bumping into the 5/min ceiling. We
# refuse to honour the disable flag when SENTRY_ENV=production so a
# misconfigured prod env var can't accidentally open the gates.
import logging as _logging
import os as _os
_disable_rl = _os.getenv("INVESTAPP_DISABLE_RATE_LIMIT") == "1"
if _disable_rl and settings.SENTRY_ENV == "production":
    _logging.getLogger("auth").warning(
        "INVESTAPP_DISABLE_RATE_LIMIT=1 ignored — refusing to disable rate limiting in production."
    )
    _disable_rl = False
limiter = Limiter(key_func=get_remote_address, enabled=not _disable_rl)

router = APIRouter(prefix="/auth", tags=["auth"])

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)


def hash_password(plain: str) -> str:
    return pwd_ctx.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    try:
        return pwd_ctx.verify(plain, hashed)
    except Exception:
        return False


def create_access_token(user_id: int, expires_in: Optional[timedelta] = None) -> str:
    expire = datetime.now(timezone.utc) + (expires_in or timedelta(days=settings.JWT_EXPIRE_DAYS))
    payload = {"sub": str(user_id), "exp": expire}
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM)


def _user_to_out(u: User) -> UserOut:
    return UserOut(
        id=u.id,
        email=u.email,
        name=u.name,
        currency=u.currency,
        has_anthropic_key=u.encrypted_anthropic_key is not None,
        created_at=u.created_at,
    )


async def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="missing token")
    try:
        payload = jwt.decode(token, settings.JWT_SECRET, algorithms=[settings.JWT_ALGORITHM])
        sub = payload.get("sub")
        # Explicit shape check: sub must be a numeric string. Defends against
        # an attacker that crafts a token with a malformed sub even if the
        # signature is correct (somehow).
        if not isinstance(sub, str) or not sub.isdigit():
            raise InvalidTokenError("malformed sub")
        user = db.get(User, int(sub))
        if not user:
            raise InvalidTokenError("user not found")
        return user
    except InvalidTokenError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or expired token")


@router.post("/register", response_model=TokenResponse, status_code=201)
@limiter.limit("5/minute")
async def register(request: Request, payload: UserRegister, db: Session = Depends(get_db)) -> TokenResponse:
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=409, detail="email already registered")
    user = User(
        email=payload.email,
        name=payload.name,
        hashed_password=hash_password(payload.password),
        currency="USD",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenResponse(access_token=create_access_token(user.id), user=_user_to_out(user))


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(request: Request, payload: UserLogin, db: Session = Depends(get_db)) -> TokenResponse:
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    return TokenResponse(access_token=create_access_token(user.id), user=_user_to_out(user))


@router.post("/demo", response_model=TokenResponse, status_code=201)
@limiter.limit("3/minute")
async def demo_login(request: Request, db: Session = Depends(get_db)) -> TokenResponse:
    """Spin up a brand-new demo user with a pre-seeded portfolio. No
    sign-up required — the landing page CTA calls this and the visitor
    lands straight on a fully-populated dashboard. Each demo user is
    isolated (no shared state) and cleaned up by a scheduler job after
    24 hours so the DB doesn't fill up.

    The email follows `demo+{uuid}@local.invest` so the scheduler can
    identify demo accounts by prefix. A random password is set so the
    account technically passes login validation but is never used (the
    JWT is returned directly here)."""
    import uuid
    import secrets
    from services.demo_seed import seed_user

    suffix = uuid.uuid4().hex[:10]
    user = User(
        email=f"demo+{suffix}@local.invest",
        name="Demo",
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        currency="USD",
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    # Seed the demo portfolio so the dashboard isn't empty.
    try:
        seed_user(db, user)
    except Exception as e:
        # Don't fail the login just because seeding broke — the user
        # can still navigate, just with an empty portfolio.
        import logging
        logging.getLogger("auth").warning("demo seed failed for %s: %s", user.email, e)
    return TokenResponse(access_token=create_access_token(user.id), user=_user_to_out(user))


@router.get("/me", response_model=UserOut)
async def me(current: User = Depends(get_current_user)) -> UserOut:
    return _user_to_out(current)
