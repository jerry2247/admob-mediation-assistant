"""Canonical AdMob mediation knowledge base.

Sourced from the project research notes (docs/00-research-notes.md), which cite
official AdMob Help. Kept deliberately concise and accurate so the agent can quote
it verbatim rather than improvise.
"""

KB: dict[str, str] = {
    "mediation group": (
        "A mediation group is a combination of targeting settings (ad format, "
        "platform, ad units, and optional location targeting) plus the ad sources "
        "used to fill those requests. It lets you configure sources once and apply "
        "them across many ad units to optimize revenue."
    ),
    "bidding": (
        "In bidding, ad sources compete in a real-time auction to fill each ad "
        "request; the highest bid wins. It's hands-off and generally maximizes "
        "competition versus a fixed waterfall."
    ),
    "waterfall": (
        "In waterfall mediation, ad sources are called one-by-one in the order of "
        "the eCPM you set (highest to lowest), not by what each source will actually "
        "pay for that impression."
    ),
    "hybrid": (
        "A hybrid group uses both bidding and waterfall ad sources together: bidders "
        "compete in the auction while waterfall sources are tried in eCPM order."
    ),
    "priority": (
        "When more than one mediation group matches an ad request's targeting "
        "(format, platform, location, etc.), the group with the highest priority — "
        "the SMALLEST number, where 1 is highest — serves the request."
    ),
    "default group": (
        "AdMob auto-creates an 'AdMob (default)' group per format that fills any "
        "request not matched by another group, sourcing ads from the AdMob Network. "
        "You can't delete it."
    ),
    "conflict avoidance": (
        "To avoid groups fighting over the same requests: if you target a country/"
        "region, platform, or ad format explicitly in one group, exclude it from the "
        "others so each request maps cleanly to one intended group."
    ),
    "ecpm floor": (
        "The bidding eCPM floor is the minimum price for the bidding auction. It "
        "applies to all bidders in the group and overrides the ad unit's floor for "
        "bidding traffic."
    ),
    "manual ecpm": (
        "For a waterfall source, the manual eCPM is the value you set to position it "
        "in the waterfall while AdMob gathers enough data to optimize."
    ),
    "optimized ecpm": (
        "Once AdMob has enough historical data for a supported waterfall source, it "
        "orders that source by an optimized eCPM instead of your manual value."
    ),
    "custom event": (
        "A custom event integrates a network AdMob doesn't natively support, via a "
        "small adapter class you implement in the app plus an ad-unit mapping."
    ),
    "ad format": (
        "The ad type a group serves: banner, interstitial, rewarded, rewarded "
        "interstitial, native, or app open. A group targets exactly one format."
    ),
    "platform": (
        "Android or iOS. You create separate mediation groups per platform because "
        "ad units and SDK integrations differ between them."
    ),
    "ad unit": (
        "An ad placement in your app. AdMob matches a group to requests from the ad "
        "units the group targets."
    ),
    "location targeting": (
        "You can include or exclude specific countries/regions for a group so it only "
        "serves (or never serves) requests from those locations."
    ),
    "idfa": (
        "On iOS, targeting can depend on whether the IDFA (advertising identifier) is "
        "available, which is governed by the user's App Tracking Transparency choice."
    ),
    "mapping": (
        "An ad-unit mapping links a third-party network's placement identifiers to an "
        "AdMob ad unit so that network can be requested through mediation."
    ),
    "sdk follow up": (
        "Third-party ad sources require the matching mediation adapter/SDK in the app "
        "and ad-unit mappings; configuring the source in AdMob alone is not enough."
    ),
}

# Ordered steps of the create-a-mediation-group flow (docs/00 §2).
CREATE_FLOW_STEPS = [
    "Open Mediation, click 'Create mediation group'.",
    "Select Ad format and Platform, then Continue.",
    "Enter a descriptive Name.",
    "Select the Ad units to target.",
    "Optionally set Location include/exclude targeting.",
    "Add ad sources (bidding / waterfall / custom event) and set eCPM floor / manual eCPM.",
    "Review, then Save.",
    "Follow up in the app: add adapter SDKs and ad-unit mappings for third-party sources.",
]


def lookup(name: str) -> str:
    """Return the best-matching KB explanation for a concept name."""
    if not name:
        return ""
    q = name.strip().lower()
    if q in KB:
        return KB[q]
    # loose contains match
    for key, val in KB.items():
        if key in q or q in key:
            return val
    # token overlap
    qt = set(q.replace("-", " ").split())
    best, score = "", 0
    for key, val in KB.items():
        s = len(qt & set(key.split()))
        if s > score:
            best, score = val, s
    return best
