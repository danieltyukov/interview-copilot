from interview_copilot.context import gather_context


def test_gathers_key_files_and_tree(tmp_path):
    (tmp_path / "README.md").write_text("# Cool Project\nDoes cool things.")
    (tmp_path / "package.json").write_text('{"name": "cool", "version": "1.0.0"}')
    src = tmp_path / "src"
    src.mkdir()
    (src / "index.js").write_text("console.log('hi')")

    ctx = gather_context(tmp_path)
    assert "Cool Project" in ctx
    assert "package.json" in ctx
    assert "index.js" in ctx
    assert str(tmp_path) in ctx


def test_ignores_noise_dirs(tmp_path):
    (tmp_path / "README.md").write_text("hello")
    nm = tmp_path / "node_modules" / "leftpad"
    nm.mkdir(parents=True)
    (nm / "index.js").write_text("module.exports = 1")

    ctx = gather_context(tmp_path)
    assert "node_modules" not in ctx
    assert "leftpad" not in ctx


def test_respects_budget(tmp_path):
    (tmp_path / "README.md").write_text("x" * 50000)
    ctx = gather_context(tmp_path, char_budget=2000)
    assert len(ctx) <= 2000 + 40  # plus the truncation marker
