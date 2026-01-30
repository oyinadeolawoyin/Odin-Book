const fs = require('fs/promises');
const { supabase } = require('../src/config/supabaseClient');
const path = require('path');

function sanitizeFilename(filename) {
  const name = path.parse(filename).name;
  const ext = path.extname(filename);
  return name
    .replace(/[^\w.-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 100) + ext;
}

/**
 * Extract the storage path from a Supabase public URL
 * @param {string} publicUrl - The full public URL from Supabase
 * @returns {string|null} - The storage path or null if invalid
 */
function extractStoragePath(publicUrl) {
  if (!publicUrl) return null;
  
  try {
    // Supabase URLs look like: https://xxx.supabase.co/storage/v1/object/public/gallery/uploads/123_file.jpg
    // We need to extract: uploads/123_file.jpg
    const url = new URL(publicUrl);
    const pathParts = url.pathname.split('/public/gallery/');
    
    if (pathParts.length > 1) {
      return pathParts[1]; // Returns "uploads/123_file.jpg"
    }
    return null;
  } catch (err) {
    console.error("Error extracting storage path:", err);
    return null;
  }
}

/**
 * Delete a file from Supabase storage
 * @param {string} publicUrl - The public URL of the file to delete
 * @returns {Promise<boolean>} - True if deleted successfully, false otherwise
 */
async function deleteFile(publicUrl) {
  if (!publicUrl) return false;

  try {
    const storagePath = extractStoragePath(publicUrl);
    
    if (!storagePath) {
      console.error("Could not extract storage path from URL:", publicUrl);
      return false;
    }

    console.log("Deleting file from Supabase:", storagePath);
    
    const { error } = await supabase.storage
      .from('voices')
      .remove([storagePath]);

    if (error) {
      console.error("Supabase delete error:", error);
      return false;
    }

    console.log("File deleted successfully:", storagePath);
    return true;
  } catch (err) {
    console.error("Error in deleteFile:", err);
    return false;
  }
}

/**
 * Delete multiple files from Supabase storage
 * @param {string[]} publicUrls - Array of public URLs to delete
 * @returns {Promise<{success: number, failed: number}>}
 */
async function deleteFiles(publicUrls) {
  if (!publicUrls || publicUrls.length === 0) {
    return { success: 0, failed: 0 };
  }

  const storagePaths = publicUrls
    .map(url => extractStoragePath(url))
    .filter(path => path !== null);

  if (storagePaths.length === 0) {
    return { success: 0, failed: publicUrls.length };
  }

  try {
    console.log("Deleting files from Supabase:", storagePaths);
    
    const { error } = await supabase.storage
      .from('voices')
      .remove(storagePaths);

    if (error) {
      console.error("Supabase batch delete error:", error);
      return { success: 0, failed: storagePaths.length };
    }

    console.log("Files deleted successfully");
    return { success: storagePaths.length, failed: 0 };
  } catch (err) {
    console.error("Error in deleteFiles:", err);
    return { success: 0, failed: storagePaths.length };
  }
}

async function uploadFile(file) {
  try {
    console.log("Reading file from temp path:", file.path);
    const fileBuffer = await fs.readFile(file.path);

    const sanitizedName = sanitizeFilename(file.originalname);
    const supabasePath = `uploads/${Date.now()}_${sanitizedName}`;

    console.log("Uploading to Supabase at path:", supabasePath);
    const { data, error } = await supabase.storage
      .from('voices')
      .upload(supabasePath, fileBuffer, {
        contentType: file.mimetype,
      });

    if (error) throw error;

    const { data: publicUrlData } = supabase.storage
      .from('voices')
      .getPublicUrl(supabasePath);

    const publicUrl = publicUrlData.publicUrl;
    console.log("Public URL generated:", publicUrl);

    try {
      await fs.unlink(file.path);
    } catch (unlinkErr) {
      console.error('Failed to delete temp file:', unlinkErr);
    }

    return publicUrl;
  } catch (err) {
    console.error("Error in uploadFile:", err);
    throw err;
  }
}

module.exports = { 
    uploadFile, 
    deleteFile, 
    deleteFiles 
};