/**
 * Bestanden veilig aanleveren — client logic.
 *
 * Flow per file: read → crypto_box_seal to the server's public key (fetched
 * once from /drop/pubkey) → POST the ciphertext with XHR (fetch has no upload
 * progress). The plaintext never leaves this browser; the server only ever
 * sees the sealed box.
 *
 * `sodium` is the global from vendor/libsodium-wrappers.js (UMD builds copied
 * out of node_modules at deploy — see server/setup_drop_server.sh).
 */

/* global sodium */

(() => {
  "use strict";

  const MAX_BYTES = 25 * 1024 * 1024; // mirror of the server's MAX_DROP_BYTES

  const dropzone = document.getElementById("dropzone");
  const chooseBtn = document.getElementById("choose");
  const fileInput = document.getElementById("fileinput");
  const list = document.getElementById("files");
  const unavailable = document.getElementById("unavailable");

  /** Resolved once: the X25519 key uploads are sealed to. */
  const publicKeyPromise = (async () => {
    await sodium.ready;
    const res = await fetch("/drop/pubkey", { cache: "no-store" });
    if (!res.ok) throw new Error(`pubkey fetch failed: ${res.status}`);
    const { publicKey } = await res.json();
    return sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  })();

  publicKeyPromise.catch(() => {
    // No key, no encryption, no uploads — disable the whole surface rather
    // than failing per file.
    dropzone.style.display = "none";
    unavailable.style.display = "block";
  });

  /** Map an HTTP status to the Dutch message shown next to the file. */
  function reasonFor(status) {
    switch (status) {
      case 413: return "Te groot (max. 25 MB)";
      case 429: return "Te veel pogingen — wacht een minuut";
      case 507: return "Opslag vol — neem contact op met de beheerder";
      default: return "Verzenden mislukt — probeer opnieuw";
    }
  }

  function addRow(name) {
    const li = document.createElement("li");
    const fname = document.createElement("span");
    fname.className = "fname";
    fname.textContent = name;
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.appendChild(document.createElement("div"));
    const state = document.createElement("span");
    state.className = "fstate";
    state.textContent = "Versleutelen…";
    li.append(fname, bar, state);
    list.appendChild(li);
    return {
      progress(fraction, label) {
        bar.firstChild.style.width = `${Math.round(fraction * 100)}%`;
        if (label) state.textContent = label;
      },
      done(kenmerk) {
        bar.remove();
        state.className = "fstate ok";
        state.textContent = "✓ Verzonden";
        if (kenmerk) {
          const k = document.createElement("div");
          k.className = "kenmerk";
          k.textContent = `uw kenmerk: ${kenmerk.slice(0, 8)}`;
          li.appendChild(k);
        }
      },
      fail(message) {
        bar.remove();
        state.className = "fstate err";
        state.textContent = `✗ ${message}`;
      },
    };
  }

  function upload(sealed, filename, row) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/drop");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-Drop-Filename", encodeURIComponent(filename));
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) row.progress(e.loaded / e.total, "Verzenden…");
      };
      xhr.onload = () => {
        if (xhr.status === 201) {
          let id = "";
          try { id = JSON.parse(xhr.responseText).id || ""; } catch { /* body optional */ }
          row.done(id);
        } else {
          row.fail(reasonFor(xhr.status));
        }
        resolve();
      };
      xhr.onerror = () => {
        row.fail("Netwerkfout — probeer opnieuw");
        resolve();
      };
      xhr.send(sealed);
    });
  }

  async function handleFiles(files) {
    let serverKey;
    try {
      serverKey = await publicKeyPromise;
    } catch {
      return; // surface already disabled
    }

    for (const file of files) {
      const row = addRow(file.name);
      // Sealed-box overhead is 48 bytes; checking the plaintext against the
      // cap client-side avoids uploading megabytes only to get a 413.
      if (file.size + 48 > MAX_BYTES) {
        row.fail(`Te groot (${Math.round(file.size / 1024 / 1024)} MB, max. 25 MB)`);
        continue;
      }
      try {
        const plaintext = new Uint8Array(await file.arrayBuffer());
        row.progress(0.05, "Versleutelen…");
        const sealed = sodium.crypto_box_seal(plaintext, serverKey);
        await upload(sealed, file.name, row);
      } catch {
        row.fail("Versleutelen mislukt");
      }
    }
  }

  chooseBtn.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("click", (e) => {
    if (e.target === dropzone || e.target.parentElement === dropzone) fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    handleFiles([...fileInput.files]);
    fileInput.value = "";
  });

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    handleFiles([...e.dataTransfer.files]);
  });
})();
