    if len(result) != 170:
        raise ValueError(f"Expected 170 cello-section SFZ regions, got {len(result)}")
    unique_paths = {item["source_path"] for item in result}
    if len(unique_paths) != 156:
        raise ValueError(f"Expected 156 unique cello-section recordings, got {len(unique_paths)}")
    return result


def build(output_root: str | Path) -> dict[str, Any]:
    root = Path(output_root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg is required to normalize recorded cello-section WAV files")

    tree_data = json.loads(_request(SOURCE_TREE_URL))
    if tree_data.get("truncated"):