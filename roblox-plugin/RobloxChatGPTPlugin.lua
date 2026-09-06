local HttpService = game:GetService("HttpService")
local ScriptEditorService = game:GetService("ScriptEditorService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")

local toolbar = plugin:CreateToolbar("Roblox ChatGPT")
local button = toolbar:CreateButton("Connect", "Connect Roblox Studio to the AI builder", "")

local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Float, true, false, 360, 220, 260, 180)
local widget = plugin:CreateDockWidgetPluginGui("RobloxChatGPTWidget", widgetInfo)
widget.Title = "Roblox ChatGPT Builder"

local root = Instance.new("Frame")
root.Size = UDim2.fromScale(1, 1)
root.BackgroundColor3 = Color3.fromRGB(20, 24, 34)
root.Parent = widget

local box = Instance.new("TextBox")
box.Size = UDim2.new(1, -20, 0, 32)
box.Position = UDim2.fromOffset(10, 10)
box.PlaceholderText = "Railway URL"
box.Text = plugin:GetSetting("serverUrl") or ""
box.Parent = root

local token = Instance.new("TextBox")
token.Size = UDim2.new(1, -20, 0, 32)
token.Position = UDim2.fromOffset(10, 50)
token.PlaceholderText = "BRIDGE_TOKEN"
token.Text = plugin:GetSetting("bridgeToken") or ""
token.Parent = root

auto = Instance.new("TextLabel")
auto.Size = UDim2.new(1, -20, 0, 50)
auto.Position = UDim2.fromOffset(10, 90)
auto.TextColor3 = Color3.new(1, 1, 1)
auto.Text = "Disconnected"
auto.TextWrapped = true
auto.Parent = root

local function setStatus(text)
	auto.Text = text
end

local function findPath(pathString)
	local current = game
	for part in string.gmatch(pathString, "[^/]+") do
		current = current:FindFirstChild(part)
		if not current then return nil end
	end
	return current
end

local function convertValue(value, property)
	if type(value) == "table" and #value == 3 then
		if property and string.find(property, "Color") then return Color3.new(value[1], value[2], value[3]) end
		return Vector3.new(value[1], value[2], value[3])
	end
	if type(value) == "table" and #value == 2 then return UDim2.new(value[1], 0, value[2], 0) end
	return value
end

local function applyCommand(item)
	local c = item.command
	if c.action == "create_instance" then
		local parent = findPath(c.parent or "Workspace")
		assert(parent, "Parent not found: " .. tostring(c.parent))
		local obj = Instance.new(c.className)
		obj.Name = c.name or c.className
		for property, value in pairs(c.properties or {}) do
			local ok, err = pcall(function() obj[property] = convertValue(value, property) end)
			if not ok then warn("Property failed", property, err) end
		end
		obj.Parent = parent
		return obj
	elseif c.action == "set_property" then
		local obj = findPath(c.path)
		assert(obj, "Instance not found: " .. tostring(c.path))
		obj[c.property] = convertValue(c.value, c.property)
	elseif c.action == "delete_instance" then
		local obj = findPath(c.path)
		assert(obj, "Instance not found: " .. tostring(c.path))
		obj:Destroy()
	elseif c.action == "set_source" then
		local obj = findPath(c.path)
		assert(obj, "Script not found: " .. tostring(c.path))
		assert(obj:IsA("LuaSourceContainer"), "Not a script: " .. tostring(c.path))
		ScriptEditorService:UpdateSourceAsync(obj, function() return c.source or "" end)
	else
		error("Unsupported action: " .. tostring(c.action))
	end
end

local function poll()
	local url = box.Text:gsub("/$", "")
	local bridgeToken = token.Text
	if url == "" or bridgeToken == "" then setStatus("Enter Railway URL and BRIDGE_TOKEN") return end
	plugin:SetSetting("serverUrl", url)
	plugin:SetSetting("bridgeToken", bridgeToken)
	local ok, response = pcall(function()
		return HttpService:GetAsync(url .. "/bridge/poll", false, { ["x-bridge-token"] = bridgeToken })
	end)
	if not ok then setStatus("Connection error: " .. tostring(response)) return end
	local data = HttpService:JSONDecode(response)
	local total = 0
	for _, item in ipairs(data.commands or {}) do
		local success, err = pcall(function()
			ChangeHistoryService:SetWaypoint("AI Before " .. tostring(item.id))
			applyCommand(item)
			ChangeHistoryService:SetWaypoint("AI After " .. tostring(item.id))
		end)
		if success then total += 1 else warn("AI command failed", err) end
	end
	setStatus(total > 0 and ("Applied " .. total .. " command(s)") or "Connected - waiting for AI commands")
end

button.Click:Connect(function() widget.Enabled = not widget.Enabled end)
widget:GetPropertyChangedSignal("Enabled"):Connect(function() if widget.Enabled then task.spawn(function() while widget.Enabled do poll(); task.wait(2) end end) end end)
