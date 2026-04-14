(() => {
  const token = localStorage.getItem("token");
  const roleNames = { 1: "User", 2: "Moderator", 3: "Manager", 4: "Admin", 5: "Superadmin" };
  const MAX_UPLOAD_BYTES = 1024 * 1024;
  // Must stay within server MAX_DATA_URL_LENGTH after base64/data-URL expansion.
  const MAX_DATA_URL_LENGTH = 2000000;

  function parseJwt(rawToken) {
    try {
      return JSON.parse(atob(rawToken.split(".")[1]));
    } catch {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getFallbackAvatar(name) {
    const letter = (name || "?").trim().charAt(0).toUpperCase() || "?";
    return `data:image/svg+xml;utf8,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#2563eb"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" font-size="44" fill="#ffffff" font-family="Arial">${letter}</text></svg>`
    )}`;
  }

  const claims = token ? parseJwt(token) : null;
  const mount = document.createElement("div");
  mount.className = "profile-menu";
  document.body.appendChild(mount);

  let profile = {
    username: claims?.username || "Guest",
    role: claims?.role || null,
    profilePictureUrl: "",
  };

  function render() {
    const role = profile.role ? `${roleNames[profile.role] || "User"} (Level ${profile.role})` : "";
    const avatarSrc = profile.profilePictureUrl || getFallbackAvatar(profile.username);

    mount.innerHTML = `
      <button type="button" class="profile-trigger" id="profileTrigger" aria-label="Profile">
        <img class="profile-avatar" src="${escapeHtml(avatarSrc)}" alt="Profile picture" />
      </button>
      <div class="profile-dropdown" id="profileDropdown">
        <div class="profile-name">${escapeHtml(profile.username)}</div>
        ${role ? `<div class="profile-role">${escapeHtml(role)}</div>` : ""}
        ${
          token
            ? `
          <input id="profilePictureInput" type="text" placeholder="Paste image URL or data URL" value="${escapeHtml(
            profile.profilePictureUrl || ""
          )}" />
          <button type="button" id="saveProfilePictureBtn">Save picture</button>
          <input id="profilePictureFileInput" type="file" accept="image/*" />
          <button type="button" id="uploadProfilePictureBtn">Upload picture</button>
          <button type="button" id="logoutFromProfileBtn" class="profile-logout-btn">Logout</button>
        `
            : `
          <a href="login.html">Login</a>
        `
        }
      </div>
    `;

    const trigger = document.getElementById("profileTrigger");
    const dropdown = document.getElementById("profileDropdown");
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      dropdown.classList.toggle("open");
    });

    document.addEventListener("click", () => dropdown.classList.remove("open"));

    if (token) {
      const saveBtn = document.getElementById("saveProfilePictureBtn");
      const uploadBtn = document.getElementById("uploadProfilePictureBtn");
      const fileInput = document.getElementById("profilePictureFileInput");
      const logoutBtn = document.getElementById("logoutFromProfileBtn");

      logoutBtn.addEventListener("click", () => {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.href = "login.html";
      });

      saveBtn.addEventListener("click", async () => {
        const input = document.getElementById("profilePictureInput");
        const profilePictureUrl = input.value.trim();
        try {
          const res = await fetch("/me/profile-picture", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ profilePictureUrl }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to save picture.");
          profile.profilePictureUrl = data.profilePictureUrl || "";
          render();
        } catch (err) {
          alert(err.message || "Failed to save picture.");
        }
      });

      uploadBtn.addEventListener("click", async () => {
        const file = fileInput.files?.[0];
        if (!file) {
          alert("Choose an image first.");
          return;
        }
        if (!file.type.startsWith("image/")) {
          alert("Only image files are allowed.");
          return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          alert("Image must be 1MB or smaller.");
          return;
        }
        const estimatedDataUrlLength = Math.ceil((file.size * 4) / 3) + 64;
        if (estimatedDataUrlLength > MAX_DATA_URL_LENGTH) {
          alert("Image is too large after encoding. Please choose a smaller image.");
          return;
        }

        try {
          const profilePictureUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
            reader.onerror = () => reject(new Error("Failed to read image file."));
            reader.readAsDataURL(file);
          });

          const res = await fetch("/me/profile-picture", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ profilePictureUrl }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Failed to upload picture.");
          profile.profilePictureUrl = data.profilePictureUrl || "";
          render();
        } catch (err) {
          alert(err.message || "Failed to upload picture.");
        }
      });
    }
  }

  async function hydrateProfile() {
    if (!token || !claims) {
      render();
      return;
    }
    try {
      const res = await fetch("/me", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        render();
        return;
      }
      const me = await res.json();
      profile = {
        username: me.username || profile.username,
        role: me.role || profile.role,
        profilePictureUrl: me.profilePictureUrl || "",
      };
      render();
    } catch {
      render();
    }
  }

  hydrateProfile();
})();
