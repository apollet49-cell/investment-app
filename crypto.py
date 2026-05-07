from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from settings import settings

_fernet = Fernet(settings.APP_ENCRYPTION_KEY.encode())


def encrypt(plaintext: str) -> bytes:
    return _fernet.encrypt(plaintext.encode())


def decrypt(ciphertext: bytes) -> str:
    try:
        return _fernet.decrypt(ciphertext).decode()
    except InvalidToken as e:
        raise ValueError("decryption failed (key changed or corrupt data)") from e
