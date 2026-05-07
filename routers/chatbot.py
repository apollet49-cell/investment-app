from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import ChatMessage, User
from schemas import ChatMessageOut, ChatSendRequest
from services.ai_service import stream_chat

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("/message")
async def post_message(
    payload: ChatSendRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    return StreamingResponse(
        stream_chat(db, current, payload.message),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/history", response_model=list[ChatMessageOut])
async def get_history(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[ChatMessageOut]:
    rows = (
        db.query(ChatMessage)
        .filter(ChatMessage.user_id == current.id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    return [
        ChatMessageOut(
            id=r.id,
            role=r.role,
            content=r.content,
            truncated=r.truncated,
            created_at=r.created_at,
        )
        for r in rows
    ]


@router.delete("/history")
async def clear_history(current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.query(ChatMessage).filter(ChatMessage.user_id == current.id).delete()
    db.commit()
    return Response(status_code=204)
