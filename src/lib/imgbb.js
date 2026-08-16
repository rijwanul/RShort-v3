// Uploads a base64 image to ImgBB and returns the display URL plus the
// delete_url (stored in D1 so admins can clean up images later).
export async function uploadToImgBB(apiKey, base64Data) {
  // ImgBB expects raw base64 only - strip a data: URL prefix like
  // "data:image/png;base64," if the caller sent a full data URL
  // (e.g. from FileReader.readAsDataURL), which otherwise causes
  // ImgBB to reject it with "Invalid base64 string".
  const raw = base64Data.includes(",") && base64Data.startsWith("data:") ? base64Data.split(",")[1] : base64Data;

  const form = new FormData();
  form.set("image", raw);

  const res = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.success) {
    throw new Error((data && data.error && data.error.message) || "ImgBB upload failed");
  }

  return {
    url: data.data.url,
    deleteUrl: data.data.delete_url,
  };
}
