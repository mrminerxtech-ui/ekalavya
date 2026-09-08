# Setting Up with GitHub Desktop (Windows — No Command Line Needed)

## What You Need
- GitHub account (github.com — free)
- GitHub Desktop (desktop.github.com — free)

---

## Step 1 — Install GitHub Desktop

1. Go to **desktop.github.com**
2. Click **Download for Windows**
3. Run the installer
4. Sign in with your GitHub account

---

## Step 2 — Create the Repository

**Option A — On GitHub.com (easiest):**

1. Go to github.com → click **+** → **New repository**
2. Name: `ekalavya`
3. Private: ✓ checked
4. Click **Create repository**
5. On the next page click **uploading an existing file**
6. Unzip the `ekalavya` project folder on your PC
7. Drag ALL files and folders into the GitHub upload page
8. Click **Commit changes**

**Option B — Via GitHub Desktop:**

1. Open GitHub Desktop
2. File → **New repository**
3. Name: `ekalavya` → Local path: choose a folder on your PC
4. Click **Create repository**
5. Copy all the project files into that folder
6. GitHub Desktop shows the changes
7. Write commit message: `Initial commit`
8. Click **Commit to main**
9. Click **Publish repository**
10. Uncheck "Keep this code private" if you want public — otherwise keep checked
11. Click **Publish repository**

---

## Step 3 — Making Changes Later

When you want to update the app (change something, fix a bug):

1. Open the file in Notepad or any editor
2. Make your changes, save
3. Open GitHub Desktop — it shows the changed files automatically
4. Type a message in the bottom left (e.g. "Changed pool list")
5. Click **Commit to main**
6. Click **Push origin** (top bar)
7. Done — GitHub Actions deploys automatically

That's it. No terminal, no git commands.

---

## Step 4 — Watching the Deployment

1. Go to your repo on github.com
2. Click the **Actions** tab
3. You'll see the workflows running with green/yellow/red status
4. Click any workflow to see details

Green ✓ = deployed successfully
Red ✗ = something went wrong (click to see the error)
