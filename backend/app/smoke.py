"""Direct (no-HTTP) smoke test of the agent: reply + derived directives + draft."""
import asyncio

from .schemas import ChatRequest, PageContext, PageControl
from .server import _run


async def main() -> None:
    pc = PageContext(
        url="https://admob.google.com/v2/mediation/groups/list",
        page="list",
        title="Mediation groups",
        controls=[
            PageControl(tag="material-button", role="button",
                        label="Create mediation group", text="Create mediation group"),
        ],
    )
    turns = [
        "What's the difference between bidding and waterfall?",
        "Okay, help me create a group for my Android interstitial. Let's start.",
        "Name it 'US Interstitial High'.",
    ]
    for msg in turns:
        reply, directives, proposed, draft = await _run(
            ChatRequest(session_id="smoke-1", message=msg, page_context=pc)
        )
        print("\nQ:", msg)
        print("A:", (reply or "")[:500])
        print("directives:", [d.model_dump() for d in directives])
        print("proposed:", proposed.model_dump() if proposed else None)
        print("draft:", draft)
        print("-" * 70)


if __name__ == "__main__":
    asyncio.run(main())
