# Cloudinary Core Share Setup

This project can upload "To the Core" screenshots to Cloudinary and share those hosted links to X/Facebook.

## 1) Create an unsigned upload preset

In Cloudinary Console:

1. Go to `Settings -> Upload -> Upload presets`.
2. Create a preset with:
   - `Signing Mode`: `Unsigned`
   - `Folder`: `core-shares` (or your preferred folder)
   - `Resource type`: `Image`
   - `Allowed formats`: `png,jpg,jpeg,webp`
   - `Moderation` / limits: configure as needed

Note:
- Unsigned presets are fast for static sites, but less secure than signed uploads.
- For production hardening, move to signed uploads with a backend signature endpoint.

## 2) Set runtime config in `index.html`

Edit the config object near the bottom of `index.html`:

```html
<script>
  window.SILENT_SAND_CONFIG = Object.assign({}, window.SILENT_SAND_CONFIG, {
    cloudinaryCloudName: 'YOUR_CLOUD_NAME',
    cloudinaryUploadPreset: 'YOUR_UNSIGNED_PRESET',
    cloudinaryFolder: 'core-shares',
    coreShareLinkBaseUrl: 'https://silentsand.me/'
  });
</script>
```

## 3) Verify behavior

1. Open `To the Core` mode and reveal the message.
2. Wait for status: `Image link ready for X/Facebook.`
3. Click `Share to X` or `Share to Facebook`.
4. Confirm the shared URL is a Cloudinary-hosted image link.

## 4) Optional hardening

- Replace unsigned upload with signed upload.
- Add rate-limiting and abuse checks in a backend endpoint.
- Add retention cleanup for old share images.
