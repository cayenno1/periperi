# Running the Application Locally

## CORS Issue Fix

The application uses Firebase and requires a web server to run properly. Opening HTML files directly (file:// protocol) will cause CORS errors.

## Quick Solutions

### Option 1: Using Python (Recommended - Simple)

1. Open a terminal/command prompt in the project directory
2. Run one of these commands:

**Python 3:**
```bash
python -m http.server 8000
```

**Python 2:**
```bash
python -m SimpleHTTPServer 8000
```

3. Open your browser and go to: `http://localhost:8000/index.html`

### Option 2: Using Node.js (if you have it installed)

1. Install a simple HTTP server globally:
```bash
npm install -g http-server
```

2. Run it in your project directory:
```bash
http-server -p 8000
```

3. Open your browser and go to: `http://localhost:8000/index.html`

### Option 3: Using VS Code

1. Install the "Live Server" extension in VS Code
2. Right-click on `index.html`
3. Select "Open with Live Server"

### Option 4: Using PHP (if you have it installed)

```bash
php -S localhost:8000
```

Then open: `http://localhost:8000/index.html`

## Important Notes

- Always use `http://localhost:8000` (or your chosen port) instead of opening files directly
- Make sure Firebase is properly configured in `firebase-init.js`
- The Firebase rules have been updated to allow staff members to update orders

