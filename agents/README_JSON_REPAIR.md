# Permanent Fix: Use json-repair for LLM output parsing

# 1. Install json-repair:
#    pip install json-repair

# 2. In orchestrator.py, replace:
#    import json
#    ...
#    parsed = json.loads(raw_text)
#    ...
#    with:
#    from json_repair import repair_json
#    ...
#    parsed = repair_json(raw_text, return_dict=True)
#    ...

# This will automatically fix most malformed JSON from LLMs, including unescaped quotes, missing brackets, and trailing commas.

# See: https://pypi.org/project/json-repair/
