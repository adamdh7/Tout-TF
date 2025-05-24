<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"/>
  <title>TOUT-TF</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background-color: #111;
      color: white;
      overflow-x: hidden;
    }

    header {
      position: sticky;
      top: 0;
      background-color: #000;
      color: white;
      padding: 10px 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 999;
    }

    header h1 {
      color: red;
      font-size: 24px;
    }

    .admin-btn, .user-btn {
      background-color: #333;
      color: white;
      border: none;
      padding: 6px 10px;
      border-radius: 5px;
      cursor: pointer;
    }

    .section, #formModal, #videoSection {
      display: none;
    }

    .video-row {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      padding: 10px;
    }

    .video-item {
      width: 150px;
      background-color: #222;
      padding: 5px;
      border-radius: 8px;
      position: relative;
    }

    .video-item video {
      width: 100%;
      height: auto;
      border-radius: 8px;
    }

    .video-title {
      margin-top: 5px;
      text-align: center;
      font-size: 12px;
    }

    .delete-btn {
      position: absolute;
      top: 5px;
      right: 5px;
      background: red;
      color: white;
      border: none;
      padding: 2px 6px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 10px;
      display: none;
    }

    #loginForm {
      padding: 20px;
      text-align: center;
    }

    #loginForm input {
      margin: 5px;
      padding: 8px;
      border-radius: 5px;
      border: none;
      width: 200px;
    }

    #loginForm button {
      margin-top: 10px;
      padding: 8px 15px;
      border: none;
      background: red;
      color: white;
      border-radius: 5px;
      cursor: pointer;
    }

    #searchBar {
      width: 100%;
      padding: 10px;
      margin-top: 10px;
      border: none;
      border-radius: 5px;
      font-size: 16px;
      background: #333;
      color: white;
    }

    #accessBox {
      background: linear-gradient(to bottom, black, red);
      color: white;
      padding: 50px 20px;
      text-align: center;
      font-size: 18px;
    }
  </style>
</head>
<body>

  <!-- Splash ak login -->
  <div id="accessBox">
    <h2>Créez un compte ou connectez-vous pour continuer</h2>
  </div>

  <div id="loginForm">
    <input type="email" id="email" placeholder="Email" /><br>
    <input type="password" id="password" placeholder="Mot de passe" /><br>
    <button onclick="connecter()">Connexion</button>
  </div>

  <header style="display:none;">
    <h1>TOUT-TF</h1>
    <button id="adminBtn" class="admin-btn" style="display:none;" onclick="ouvrirFormulaire()">+</button>
    <button id="userBtn" class="user-btn" style="display:none;">///</button>
  </header>

  <div class="section" id="videoSection">
    <input type="text" id="searchBar" placeholder="Rechercher une vidéo..." oninput="filtrerVideos()" />
    <div class="video-row" id="videoContainer">
      <!-- Preloaded films -->
      <div class="video-item">
        <video src="https://archive.org/download/night_of_the_living_dead/night_of_the_living_dead_512kb.mp4" controls></video>
        <div class="video-title">Night of the Living Dead</div>
      </div>
      <div class="video-item">
        <video src="https://archive.org/download/Plan9FromOuterSpace/Plan_9_from_Outer_Space_512kb.mp4" controls></video>
        <div class="video-title">Plan 9 from Outer Space</div>
      </div>
      <div class="video-item">
        <video src="https://archive.org/download/CharlieChaplinTheKid1921/CharlieChaplin_TheKid_512kb.mp4" controls></video>
        <div class="video-title">The Kid - Chaplin</div>
      </div>
    </div>
  </div>

  <!-- Form modal -->
  <div id="formModal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:#000a; justify-content:center; align-items:center;">
    <div style="background:#222; padding:20px; border-radius:10px; width:90%; max-width:400px;">
      <h3>Importer une vidéo</h3>
      <input type="text" id="videoNom" placeholder="Nom vidéo" style="width:100%; padding:8px;"><br><br>
      <input type="text" id="videoSaison" placeholder="Saison" style="width:100%; padding:8px;"><br><br>
      <input type="text" id="videoEpisode" placeholder="Épisode" style="width:100%; padding:8px;"><br><br>
      <input type="file" id="videoFile" accept="video/*" style="display:none;">
      <button onclick="choisirFichier()">Choisir vidéo</button>
      <button onclick="ajouterVideo()">Ajouter</button>
      <button onclick="fermerFormulaire()" style="float:right;">Fermer</button>
    </div>
  </div>

  <script>
    const ADMIN_EMAIL = "tergenefocus@gmail.com";
    const ADMIN_PASSWORD = "Tchengy1";
    let isAdmin = false;
    let selectedFile = null;

    function connecter() {
      const email = document.getElementById("email").value.trim();
      const pass = document.getElementById("password").value.trim();
      if (!email || !pass) return;

      document.getElementById("accessBox").style.display = "none";
      document.getElementById("loginForm").style.display = "none";
      document.querySelector("header").style.display = "flex";
      document.getElementById("videoSection").style.display = "block";

      if (email === ADMIN_EMAIL && pass === ADMIN_PASSWORD) {
        document.getElementById("adminBtn").style.display = "inline-block";
        isAdmin = true;
      } else {
        document.getElementById("userBtn").style.display = "inline-block";
      }
    }

    function ouvrirFormulaire() {
      document.getElementById("formModal").style.display = "flex";
    }

    function fermerFormulaire() {
      document.getElementById("formModal").style.display = "none";
    }

    function choisirFichier() {
      const fileInput = document.getElementById("videoFile");
      fileInput.click();
      fileInput.onchange = () => {
        selectedFile = fileInput.files[0];
      };
    }

    function ajouterVideo() {
      const nom = document.getElementById("videoNom").value.trim();
      const saison = document.getElementById("videoSaison").value.trim();
      const episode = document.getElementById("videoEpisode").value.trim();

      if (!selectedFile || !nom || !saison || !episode) {
        alert("Remplissez tous les champs.");
        return;
      }

      const fileURL = URL.createObjectURL(selectedFile);
      const container = document.getElementById("videoContainer");

      const videoItem = document.createElement("div");
      videoItem.className = "video-item";

      const video = document.createElement("video");
      video.src = fileURL;
      video.controls = true;

      const title = document.createElement("div");
      title.className = "video-title";
      title.innerHTML = `${nom}<br>${saison} - ${episode}`;

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.innerText = "Supprime";
      if (isAdmin) deleteBtn.style.display = "block";
      deleteBtn.onclick = () => videoItem.remove();

      videoItem.appendChild(video);
      videoItem.appendChild(title);
      videoItem.appendChild(deleteBtn);
      container.appendChild(videoItem);

      fermerFormulaire();
      selectedFile = null;
    }

    function filtrerVideos() {
      const query = document.getElementById("searchBar").value.toLowerCase();
      const items = document.querySelectorAll(".video-item");

      items.forEach(item => {
        const title = item.querySelector(".video-title").innerText.toLowerCase();
        item.style.display = title.includes(query) ? "block" : "none";
      });
    }
  </script>
</body>
</html>
