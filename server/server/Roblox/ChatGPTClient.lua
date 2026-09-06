local HttpService = game:GetService("HttpService")

local SERVER_URL = "https://YOUR-SERVER-URL/chat"

local function AskChatGPT(message)
	local success, response = pcall(function()
		return HttpService:PostAsync(
			SERVER_URL,
			HttpService:JSONEncode({
				message = message
			}),
			Enum.HttpContentType.ApplicationJson
		)
	end)

	if not success then
		warn("ChatGPT Error:", response)
		return nil
	end

	local data = HttpService:JSONDecode(response)
	return data.reply
end

-- Test
local reply = AskChatGPT("Hello, ChatGPT!")
print("ChatGPT:", reply)
